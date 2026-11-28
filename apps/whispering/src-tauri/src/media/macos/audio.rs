//! CoreAudio output-activity read, the gate that makes macOS resume safe.
//!
//! MediaRemote gives us no in-process read on macOS 15.4+: the now-playing read
//! is entitlement-gated to Apple bundle ids, so we cannot ask it "is anything
//! playing." CoreAudio's process-object list can answer a coarser version of
//! that question, and it is exactly enough: it is a public API, needs no TCC
//! permission (we only enumerate processes, never tap their samples), and
//! reports per-process output activity.
//!
//! We use it for one job. We only remember a paused set (and therefore only ever
//! resume) when we observed a process genuinely producing output audio at the
//! moment we paused. That kills the one real surprise of a read-less resume:
//! re-starting something the user had already paused themselves (an app that was
//! paused produces no output audio, so it is never in our set).
//!
//! `kAudioHardwarePropertyProcessObjectList` and the per-process activity
//! properties arrived in macOS 14.4. On older systems the selectors are unknown
//! and the calls error; we return an empty set and the caller degrades to
//! pause-only, exactly the behavior macOS shipped before this read existed.
//!
//! CoreAudio is a public framework, so unlike MediaRemote we hard-link it.

use core_foundation_sys::base::{Boolean, CFIndex, CFRelease, CFTypeRef};
use core_foundation_sys::string::{
    kCFStringEncodingUTF8, CFStringEncoding, CFStringGetCString, CFStringGetCStringPtr,
    CFStringGetLength, CFStringRef,
};
use std::ffi::{c_void, CStr};
use std::os::raw::c_char;
use std::ptr;

type OSStatus = i32;
type AudioObjectID = u32;
type AudioObjectPropertySelector = u32;
type AudioObjectPropertyScope = u32;
type AudioObjectPropertyElement = u32;

#[repr(C)]
struct AudioObjectPropertyAddress {
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope,
    element: AudioObjectPropertyElement,
}

// Four-char-code selectors, verified against the CommandLineTools SDK
// CoreAudio/AudioHardware.h + AudioHardwareBase.h.
const SYSTEM_OBJECT: AudioObjectID = 1; // kAudioObjectSystemObject
const SCOPE_GLOBAL: AudioObjectPropertyScope = 0x676c_6f62; // 'glob'
const ELEMENT_MAIN: AudioObjectPropertyElement = 0; // kAudioObjectPropertyElementMain
const PROCESS_OBJECT_LIST: AudioObjectPropertySelector = 0x7072_7323; // 'prs#'
const IS_RUNNING_OUTPUT: AudioObjectPropertySelector = 0x7069_726f; // 'piro'
const BUNDLE_ID: AudioObjectPropertySelector = 0x7062_6964; // 'pbid'

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyDataSize(
        object_id: AudioObjectID,
        address: *const AudioObjectPropertyAddress,
        qualifier_data_size: u32,
        qualifier_data: *const c_void,
        out_data_size: *mut u32,
    ) -> OSStatus;

    fn AudioObjectGetPropertyData(
        object_id: AudioObjectID,
        address: *const AudioObjectPropertyAddress,
        qualifier_data_size: u32,
        qualifier_data: *const c_void,
        io_data_size: *mut u32,
        out_data: *mut c_void,
    ) -> OSStatus;
}

fn global_address(selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        selector,
        scope: SCOPE_GLOBAL,
        element: ELEMENT_MAIN,
    }
}

/// Bundle ids of processes currently producing output audio. Empty when nothing
/// is playing, when the host predates the macOS 14.4 process-object API, or on
/// any CoreAudio error: the caller reads "empty" as "nothing safe to resume."
pub fn output_active_bundle_ids() -> Vec<String> {
    let Some(processes) = process_object_list() else {
        return Vec::new();
    };
    processes
        .into_iter()
        .filter(|&process| is_running_output(process))
        .filter_map(bundle_id)
        .collect()
}

fn process_object_list() -> Option<Vec<AudioObjectID>> {
    let address = global_address(PROCESS_OBJECT_LIST);
    let mut byte_size: u32 = 0;
    // SAFETY: `address` outlives the call; a null qualifier is valid here.
    let status = unsafe {
        AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &address, 0, ptr::null(), &mut byte_size)
    };
    if status != 0 || byte_size == 0 {
        return None;
    }
    let count = byte_size as usize / std::mem::size_of::<AudioObjectID>();
    let mut ids: Vec<AudioObjectID> = vec![0; count];
    // SAFETY: `ids` holds `byte_size` bytes; `io_data_size` reports its capacity.
    let status = unsafe {
        AudioObjectGetPropertyData(
            SYSTEM_OBJECT,
            &address,
            0,
            ptr::null(),
            &mut byte_size,
            ids.as_mut_ptr().cast::<c_void>(),
        )
    };
    if status != 0 {
        return None;
    }
    // The list can shrink between the two calls if a process exited; trust the
    // byte count the second call wrote back.
    ids.truncate(byte_size as usize / std::mem::size_of::<AudioObjectID>());
    Some(ids)
}

fn is_running_output(process: AudioObjectID) -> bool {
    let address = global_address(IS_RUNNING_OUTPUT);
    let mut running: u32 = 0;
    let mut byte_size = std::mem::size_of::<u32>() as u32;
    // SAFETY: the property is a UInt32; `running` matches its size.
    let status = unsafe {
        AudioObjectGetPropertyData(
            process,
            &address,
            0,
            ptr::null(),
            &mut byte_size,
            ptr::addr_of_mut!(running).cast::<c_void>(),
        )
    };
    status == 0 && running != 0
}

fn bundle_id(process: AudioObjectID) -> Option<String> {
    let address = global_address(BUNDLE_ID);
    let mut cf_string: CFStringRef = ptr::null();
    let mut byte_size = std::mem::size_of::<CFStringRef>() as u32;
    // SAFETY: the property yields a +1 CFStringRef we own and release below.
    let status = unsafe {
        AudioObjectGetPropertyData(
            process,
            &address,
            0,
            ptr::null(),
            &mut byte_size,
            ptr::addr_of_mut!(cf_string).cast::<c_void>(),
        )
    };
    if status != 0 || cf_string.is_null() {
        return None;
    }
    let owned = cf_string_to_string(cf_string);
    // SAFETY: kAudioProcessPropertyBundleID hands back a CFString the caller owns.
    unsafe { CFRelease(cf_string as CFTypeRef) };
    owned.filter(|id| !id.is_empty())
}

fn cf_string_to_string(cf_string: CFStringRef) -> Option<String> {
    // SAFETY: `cf_string` is a valid, retained CFStringRef for this call.
    unsafe {
        let fast = CFStringGetCStringPtr(cf_string, kCFStringEncodingUTF8);
        if !fast.is_null() {
            return CStr::from_ptr(fast).to_str().ok().map(str::to_owned);
        }
        // No backing C string; copy it out. UTF-8 needs at most 3 bytes per
        // UTF-16 unit (surrogate pairs collapse to 4 bytes for 2 units), plus NUL.
        let len = CFStringGetLength(cf_string);
        let capacity = len * 3 + 1;
        let mut buffer = vec![0 as c_char; capacity as usize];
        let copied: Boolean = CFStringGetCString(
            cf_string,
            buffer.as_mut_ptr(),
            capacity as CFIndex,
            kCFStringEncodingUTF8 as CFStringEncoding,
        );
        if copied == 0 {
            return None;
        }
        Some(
            CStr::from_ptr(buffer.as_ptr())
                .to_string_lossy()
                .into_owned(),
        )
    }
}
