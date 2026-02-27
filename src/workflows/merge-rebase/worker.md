You are updating a PR branch with the latest staging changes.

## Target Branch

`{{BRANCH}}`

## Your Mission

Merge `origin/staging` into the target branch, resolve any conflicts,
and verify no regressions were introduced.

### Steps

1. **Fetch latest**
   ```bash
   git fetch origin
   ```

2. **Checkout the target branch**
   ```bash
   git checkout {{BRANCH}}
   ```

3. **Merge staging**
   ```bash
   git merge origin/staging
   ```

4. **Resolve conflicts** (if any)
   - Review each conflicted file carefully
   - Resolve conflicts preserving the intent of both sides
   - Stage resolved files

5. **Verify no regressions**
   - Run `check-types` to verify TypeScript compilation
   - Run `lint` to verify code style
   - Run `run-tests` to verify all tests pass

6. **Fix any issues** introduced by the merge

7. **Commit the merge** (if not auto-committed by git merge)

8. **Push** when all checks pass