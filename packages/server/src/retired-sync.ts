/**
 * The Durable Object classes the retired Yjs store sync used, kept empty.
 *
 * `StoreAuthority` held each store generation's log and `GenerationsLedger`
 * which generations existed. Nothing routes to them any more. They stay
 * exported under their deployed names because a Worker that stops exporting a
 * class its migrations created fails to deploy, and the only way to retire
 * one is a `deleted_classes` migration, which permanently deletes every
 * object's stored data. Keeping the empty classes keeps that data on
 * Cloudflare, unread, until someone decides to delete it.
 */
import { DurableObject } from 'cloudflare:workers';

export class StoreAuthority extends DurableObject {}

export class GenerationsLedger extends DurableObject {}
