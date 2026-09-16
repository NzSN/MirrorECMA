# Lease implementation contract

Implement `adapter.mjs`, exporting `createAdapter()`. It returns `{actions,
observe}`. Actions return `undefined` or a promise resolving to `undefined`.
Use JavaScript `bigint` for integers and native `Set<bigint>` for `Owners`.

- `Initialize({})`: clear all state. Owners is empty; Epoch, Expires, Now and
  Writes are zero; Accepted is false.
- `Acquire({Client})`: grant if there is no owner or Now is at least Expires.
  A grant replaces Owners with the singleton Client, increments Epoch, sets
  Expires to Now + 3, and sets Accepted true. A denial only sets Accepted false.
- `Renew({Client,Token})`: valid only if Client is the owner, Token equals Epoch,
  and Now is strictly less than Expires. Set Accepted to validity. If valid, set
  Expires to Now + 3; otherwise leave the lease unchanged.
- `Release({Client,Token})`: the same validity rule. Set Accepted to validity;
  if valid clear Owners. Leave Epoch and Expires unchanged.
- `Write({Client,Token})`: the same validity rule. Set Accepted to validity;
  increment Writes only if valid.
- `Advance({Amount})`: advance Now by the nonnegative amount, preserving all
  other stored fields. Expired Owners remain recorded until replaced/released;
  validity always checks time. The clock does not advance by itself.

`observe()` returns exactly `{Owners, Epoch, Expires, Now, Accepted, Writes}`
from the actual implementation state. Observing must not mutate the service.
Initializers reset state even when called again on an existing adapter.
Calls are awaited and serialized; clients are distinguished by Client and Token.
No background timer or network service is necessary.
