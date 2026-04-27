# Code Coverage Reporting

QuorumProof uses automated code coverage reporting to maintain code quality and ensure comprehensive test coverage.

## Overview

- **Tool**: Vitest with v8 coverage provider
- **Minimum Thresholds**: 70% lines, 70% functions, 65% branches, 70% statements
- **Reports**: HTML, JSON, LCOV, and text formats
- **CI/CD**: Automated coverage checks on every push and pull request

## Running Coverage Locally

### Generate Coverage Report

```bash
cd frontend
npm run test:coverage
```

This will:
1. Run all tests with coverage instrumentation
2. Generate coverage reports in multiple formats
3. Display coverage summary in the terminal

### View HTML Report

After running coverage, open the HTML report:

```bash
open frontend/coverage/lcov-report/index.html
```

Or on Linux:
```bash
xdg-open frontend/coverage/lcov-report/index.html
```

## Coverage Reports

### Report Formats

- **HTML**: Interactive coverage report with drill-down capability
  - Location: `frontend/coverage/lcov-report/index.html`
  - Best for: Visual inspection and detailed analysis

- **JSON**: Machine-readable coverage data
  - Location: `frontend/coverage/coverage-final.json`
  - Best for: CI/CD integration and programmatic analysis

- **LCOV**: Standard coverage format
  - Location: `frontend/coverage/lcov.info`
  - Best for: Third-party tools like Codecov

- **Text**: Terminal output summary
  - Displayed after test run
  - Best for: Quick overview

## Coverage Thresholds

Current thresholds are configured in `frontend/vite.config.ts`:

```typescript
coverage: {
  lines: 70,
  functions: 70,
  branches: 65,
  statements: 70,
}
```

### Adjusting Thresholds

To increase coverage requirements:

1. Edit `frontend/vite.config.ts`
2. Update the coverage thresholds
3. Run `npm run test:coverage` to verify
4. Commit changes

## GitHub Actions Integration

Coverage is automatically reported on:

- **Push to main/develop**: Full coverage report generated
- **Pull Requests**: Coverage comment added to PR with metrics
- **Artifacts**: Coverage reports archived for 30 days

### Codecov Integration

Coverage reports are automatically uploaded to [Codecov](https://codecov.io) for:
- Historical tracking
- Badge generation
- Trend analysis

## Best Practices

### Writing Testable Code

1. **Keep functions small and focused**
   - Easier to test thoroughly
   - Better coverage metrics

2. **Avoid complex conditionals**
   - Use helper functions
   - Improves branch coverage

3. **Test edge cases**
   - Null/undefined values
   - Error conditions
   - Boundary values

### Improving Coverage

1. **Identify uncovered lines**
   - Use HTML report to find gaps
   - Focus on critical paths first

2. **Test error paths**
   - Mock failures
   - Test error handling

3. **Test user interactions**
   - Click handlers
   - Form submissions
   - Navigation

## Troubleshooting

### Coverage Not Generated

```bash
# Clear cache and reinstall
rm -rf frontend/node_modules frontend/package-lock.json
cd frontend
npm install
npm run test:coverage
```

### Coverage Below Threshold

1. Check which files are below threshold
2. Add tests for uncovered lines
3. Run coverage again to verify improvement

### Codecov Upload Fails

- Check GitHub Actions logs
- Verify Codecov token is set (if using private repo)
- Check file permissions

## Resources

- [Vitest Coverage Documentation](https://vitest.dev/guide/coverage.html)
- [Codecov Documentation](https://docs.codecov.io)
- [LCOV Format](https://github.com/linux-test-project/lcov)

## Contributing

When submitting pull requests:

1. Run `npm run test:coverage` locally
2. Ensure coverage meets thresholds
3. Add tests for new features
4. Review coverage report for gaps

Coverage reports are automatically checked in CI/CD and must pass before merging.
