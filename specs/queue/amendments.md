# Queue amendments
Summary: Records the Lord's amendments on a queue row and refuses merging past an unreconciled one.
Code: src/amendment
Search words: amendment, check-queue-amendments-reconciled

## What it does

`amendment` numbers and stores the Lord's change to a filed row and tells its in-flight Alpha and the Regent. `check-queue-amendments-reconciled` exits 66 when an Alpha's plan has not reconciled every amendment, which blocks pushing and merging.

## Sub-features

- AM-RECORD: Each amendment gets the next number.
- AM-DELIVERED: A delivered row refuses amendments.
- AM-RECONCILED: An unreconciled amendment exits 66.

## How to reach it and prove it works

```
bun test ./src/amendment/check-reconciled-runtime.test.ts
```

## Gotchas

Only a Stager or the Regent may record an amendment.
