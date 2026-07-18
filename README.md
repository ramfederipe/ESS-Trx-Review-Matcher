# ESS Txn Review Checker

This app watches the ESS transaction review page for rows where:

- Reason is `Wrong amount`
- The detail says `GatewayTransactionId matched`
- The detail includes `transaction amount ... did not match API statement amount ...` or `did not match SMS amount ...`
- The reason is `Wrong phone number` and the detail identifies the matching SMS or API statement phone
- The reason is `Manual approval required`, the transaction phone matches the SMS phone, and SMS amount/phone data is complete

For Wrong amount rows, it changes `Amount` to the matched API/SMS amount. For Wrong phone number rows, it keeps the amount and puts the matched API/SMS phone into `Correct Customer Phone`. Manual approval rows use the SMS amount and are processed only when transaction and SMS phones match. All flows select the matching merchant and can click `Make up deposit`.

The app starts in dry-run mode. Dry-run fills the modal but does not click `Make up deposit`.

## Start

Double-click `start.cmd`, or run it from this folder.

The dashboard opens at:

`http://127.0.0.1:5177`

Chrome will open with a dedicated profile folder named `chrome-profile`. Log in to ESS in that Chrome window once. The app reuses that session after restart.

## Transaction History

Every detected wrong-amount row is saved to `data/transactions.json` before the app acts on it. The dashboard Transaction History can search by reference, Gateway/SMS ID, phone, merchant, agent, status, reason, or outcome. Details include the original row information and its action timeline, even after the row is removed from Txn Review.

## Start With Windows

Double-click `install-startup-task.cmd` to make ESS Txn Review Checker start whenever you log in to Windows.

Double-click `remove-startup-task.cmd` to remove that startup task.

## Live Mode

Live mode performs real `Make up deposit` clicks. In the dashboard, type `LIVE` when switching out of dry-run mode.

The app records submitted transaction references in `data/processed.json` so it does not submit the same reference again while it remains visible.
In live mode, a submitted reference that remains visible on a later scan is removed from Txn Review and the confirmation dialog is accepted.
Rows whose corrected amount is outside the global amount range are skipped and remain in Txn Review. Wrong phone rows keep their transaction amount, so that unchanged amount is used for the range.

If an edit modal reports that the Gateway Transaction ID is already used and the make-up deposit is blocked to prevent double credit, live mode removes that row from Txn Review and confirms the removal. Dry-run mode only reports the blocked duplicate and does not remove it.

## Settings

Edit `config.json` if needed:

- `checkIntervalMs`: how often to scan the page
- `maxItemsPerCycle`: maximum rows to process per scan
- `minAmount`: global minimum corrected amount
- `maxAmount`: global maximum corrected amount; `0` means no maximum
- `enableWrongAmount`: enables or disables Wrong amount processing
- `enableWrongPhone`: enables or disables Wrong phone number processing
- `enableManualApproval`: enables or disables Manual approval required processing
- `dryRun`: `true` means fill only; `false` means click `Make up deposit`
- `allowedStatuses`: leave empty for all statuses, or use values like `["Missing"]`

## Stop

Use the dashboard Stop button, or close the terminal window running `start.cmd`.
