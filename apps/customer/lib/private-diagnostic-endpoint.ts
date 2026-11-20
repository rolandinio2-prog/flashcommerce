import * as diagnostic from './staff-me-diagnostic';
import {install} from './early-endpoint.mjs';
// Literal env references are required for Next public-variable substitution.
try {
 install(typeof window==='undefined'?undefined:window, {
  NEXT_PUBLIC_FLASH_STAFF_DIAGNOSTICS:process.env.NEXT_PUBLIC_FLASH_STAFF_DIAGNOSTICS,
  NEXT_PUBLIC_FLASH_STAFF_DIAGNOSTIC_BUILD:process.env.NEXT_PUBLIC_FLASH_STAFF_DIAGNOSTIC_BUILD,
 }, diagnostic);
} catch { /* Diagnostics cannot change authentication decisions. */ }
