//! The credential-free account captured by an application's local storage.
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountIdentity {
    pub authority_id: String,
    pub principal_id: String,
}

pub fn path(account: Option<&AccountIdentity>) -> Result<String, String> {
    let Some(account) = account else {
        return Ok("no-account".into());
    };
    fn encode(value: &str) -> Result<String, String> {
        if value.is_empty() || value.chars().any(char::is_control) {
            return Err("Invalid device account identity.".into());
        }
        Ok(value
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }
    Ok(format!(
        "accounts/{}/{}",
        encode(&account.authority_id)?,
        encode(&account.principal_id)?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wire_identity_matches_the_browser_path_encoding() {
        assert_eq!(path(None).unwrap(), "no-account");
        let account = AccountIdentity {
            authority_id: "a".into(),
            principal_id: "B".into(),
        };
        assert_eq!(path(Some(&account)).unwrap(), "accounts/61/42");
    }
}
