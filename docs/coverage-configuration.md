# Coverage Configuration Guide

This document explains the code coverage configuration for QuorumProof.

## Configuration Files

### 1. `frontend/vite.config.ts`

Main coverage configuration:

```typescript
test: {
  coverage: {
    provider: "v8",                    // Coverage provider
    reporter: ["text", "json", "html", "lcov"],  // Report formats
    exclude: [                         // Files to exclude
      "node_modules/",
      "dist/",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/index.ts",
      "src/main.tsx",
      "src/setupTests.ts",
    ],
    lines: 70,                        // Line coverage threshold
    functions: 70,                    // Function coverage threshold
    branches: 65,                     // Branch coverage threshold
    statements: 70,                   // Statement coverage threshold
  },
}
```

### 2. `.github/workflows/coverage.yml`

GitHub Actions workflow for automated coverage:

- Runs on push to main/develop
- Runs on pull requests
- Uploads to Codecov
- Comments on PRs with coverage metrics
- Archives reports for 30 days

### 3. `scripts/coverage.sh`

Local coverage reporting script:

```bash
./scripts/coverage.sh
```

Generates and displays coverage reports locally.

## Metrics Explained

### Lines
Percentage of executable lines covered by tests.
- **Target**: 70%
- **Why**: Ensures most code paths are tested

### Functions
Percentage of functions called during tests.
- **Target**: 70%
- **Why**: Ensures functions are actually used in tests

### Branches
Percentage of conditional branches executed.
- **Target**: 65% (lower than others)
- **Why**: Some branches are harder to test (error cases, edge cases)

### Statements
Percentage of statements executed.
- **Target**: 70%
- **Why**: Similar to lines, ensures code is exercised

## Excluded Files

The following are excluded from coverage:

- `node_modules/` - Dependencies
- `dist/` - Build output
- `**/*.test.ts` - Test files themselves
- `**/*.test.tsx` - Test files themselves
- `**/index.ts` - Re-export files
- `src/main.tsx` - Entry point
- `src/setupTests.ts` - Test setup

## Adjusting Thresholds

### Increase Thresholds

To require higher coverage:

1. Edit `frontend/vite.config.ts`
2. Increase threshold values
3. Add tests to meet new thresholds
4. Verify with `npm run test:coverage`

Example:
```typescript
coverage: {
  lines: 80,      // Increased from 70
  functions: 80,  // Increased from 70
  branches: 75,   // Increased from 65
  statements: 80, // Increased from 70
}
```

### Decrease Thresholds

To lower requirements (not recommended):

1. Edit `frontend/vite.config.ts`
2. Decrease threshold values
3. Document why in commit message

## Adding Exclusions

To exclude additional files:

1. Edit `frontend/vite.config.ts`
2. Add pattern to `exclude` array
3. Use glob patterns (e.g., `**/mock/**`)

Example:
```typescript
exclude: [
  "node_modules/",
  "dist/",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/mocks/**",      // New exclusion
  "**/fixtures/**",   // New exclusion
]
```

## Report Formats

### HTML Report
- **Location**: `frontend/coverage/lcov-report/index.html`
- **Use**: Visual inspection, drill-down analysis
- **Features**: 
  - File-by-file breakdown
  - Line-by-line highlighting
  - Coverage trends

### JSON Report
- **Location**: `frontend/coverage/coverage-final.json`
- **Use**: Programmatic access, CI/CD integration
- **Format**: Structured coverage data

### LCOV Report
- **Location**: `frontend/coverage/lcov.info`
- **Use**: Third-party tools, Codecov upload
- **Format**: Standard coverage format

### Text Report
- **Display**: Terminal output
- **Use**: Quick overview, CI/CD logs
- **Format**: Human-readable summary

## CI/CD Integration

### GitHub Actions

Coverage workflow runs:
1. On push to main/develop
2. On pull requests
3. Uploads to Codecov
4. Comments on PRs

### Codecov

- Tracks coverage over time
- Generates badges
- Provides trend analysis
- Integrates with GitHub

## Troubleshooting

### Coverage Not Meeting Threshold

1. Run `npm run test:coverage`
2. Open `frontend/coverage/lcov-report/index.html`
3. Identify uncovered files
4. Add tests for uncovered code
5. Re-run coverage

### Specific File Below Threshold

1. Click file in HTML report
2. See uncovered lines highlighted
3. Add tests for those lines
4. Verify coverage improved

### Workflow Failing

1. Check GitHub Actions logs
2. Verify dependencies installed
3. Check Node.js version
4. Verify test files exist

## Best Practices

1. **Aim for high coverage**: 80%+ is ideal
2. **Test critical paths**: Focus on business logic
3. **Test error cases**: Don't just test happy path
4. **Keep thresholds reasonable**: Don't over-engineer
5. **Review coverage regularly**: Track trends

## Resources

- [Vitest Coverage](https://vitest.dev/guide/coverage.html)
- [V8 Coverage](https://v8.dev/docs/coverage)
- [Codecov](https://codecov.io)
- [LCOV Format](https://github.com/linux-test-project/lcov)
