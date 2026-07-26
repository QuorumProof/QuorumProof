# Accessibility Guidelines — Issue #1251

This document outlines the accessibility requirements and testing practices for the QuorumProof frontend.

## Standards

We follow these accessibility standards:

- **WCAG 2.1 Level AA**: Target level for all UI components
- **Section 508**: US federal accessibility compliance
- **ARIA Authoring Practices Guide (APG)**: Semantic markup patterns

## Testing

### Automated Testing with axe-core

We use [jest-axe](https://github.com/nickcolley/jest-axe) to catch accessibility violations in unit and integration tests.

#### Running Accessibility Tests

```bash
# Run all tests (includes a11y checks)
npm test

# Run only accessibility tests
npm test -- accessibility.a11y

# Run with coverage
npm test:coverage
```

#### Adding Accessibility Tests

Use the `checkA11y()` utility from `src/__tests__/utils/accessibility.test.utils.ts`:

```typescript
import { checkA11y } from './utils/accessibility.test.utils'

it('should have no accessibility violations', async () => {
  const result = render(<YourComponent />)
  await checkA11y(result)
})
```

### Manual Testing Checklist

Before shipping, verify:

- [ ] Keyboard navigation (Tab, Enter, Escape, Arrow keys work as expected)
- [ ] Screen reader support (NVDA, JAWS, VoiceOver)
- [ ] Color contrast (4.5:1 for normal text, 3:1 for large text)
- [ ] Focus indicators (visible outline around focused elements)
- [ ] Form labels properly associated with inputs
- [ ] Error messages announced to assistive technologies
- [ ] Dynamic content changes announced (live regions)

## Common Patterns

### Accessible Button

```tsx
<button
  onClick={handleClick}
  aria-label="Clear all filters"
  aria-pressed={isActive}
>
  Clear
</button>
```

### Accessible Form Input

```tsx
<div>
  <label htmlFor="credential-id">Credential ID</label>
  <input
    id="credential-id"
    type="text"
    placeholder="Enter credential ID"
    aria-describedby="credential-help"
  />
  <small id="credential-help">
    Enter a valid Stellar credential ID
  </small>
</div>
```

### Accessible Dialog

```tsx
<div
  role="dialog"
  aria-modal="true"
  aria-labelledby="dialog-title"
>
  <h2 id="dialog-title">Confirm Action</h2>
  <p>Are you sure you want to proceed?</p>
  <button>Cancel</button>
  <button>Confirm</button>
</div>
```

### Live Region for Notifications

```tsx
<div role="alert" aria-live="polite" aria-atomic="true">
  {message}
</div>
```

## CI/CD Integration

Our CI pipeline includes:

1. **Linting**: ESLint with a11y plugin checks
2. **Unit Tests**: jest-axe checks in test suite
3. **Build Checks**: Verify no TypeScript/build errors

Failed accessibility checks will block PR merges.

## Resources

- [WebAIM: Introduction to Web Accessibility](https://webaim.org/intro/)
- [MDN: ARIA Roles](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles)
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [jest-axe Documentation](https://github.com/nickcolley/jest-axe)
- [axe-core Rules](https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md)

## Reporting Issues

Found an accessibility issue? Create a GitHub issue with:

- Component name
- Steps to reproduce
- Expected behavior
- Actual behavior
- Assistive technology used (if applicable)

## Contributing

When adding new components:

1. Include semantic HTML (button, input, label, etc.)
2. Add ARIA attributes where necessary
3. Write a11y test cases
4. Test with keyboard navigation
5. Verify with a screen reader (NVDA on Windows, VoiceOver on Mac)
