---
name: verify
description: Run type-check and all tests to verify the project is in a good state. Use after making changes or before committing.
---

Run the following commands in sequence. Stop at the first failure and report the error.

1. Type-check: `npm run lint`
2. Run all tests: `npm test`

Report the results concisely:
- Number of tests passed/failed
- Any type errors found
- If everything passes, say so in one line
