import '@testing-library/jest-dom'
import 'jest-axe/extend-expect'

// Configure axe for accessibility testing
import { configureAxe } from 'jest-axe'

configureAxe({
  rules: {
    // Disable certain rules that may be too noisy in testing
    'color-contrast': { enabled: true },
  },
})
