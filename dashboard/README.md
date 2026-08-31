# Dashboard

Frontend dashboard for the QuorumProof credential verification platform.

## Features

- **CredentialCard Component**: Reusable, accessible component for displaying credentials
- **TypeScript Support**: Full type safety
- **Responsive Design**: Works on all screen sizes
- **Accessibility**: WCAG compliant with keyboard navigation and ARIA labels
- **Dark Mode**: Automatic theme detection

## Getting Started

### Environment Variables

Before running the dashboard, copy `.env.example` (or create `.env.local`) and set:

| Variable | Required | Description |
|---|---|---|
| `VITE_WS_URL` | No | WebSocket endpoint (default: `ws://localhost:3000/ws`) |
| `VITE_DASHBOARD_TOKEN` | **Yes** | Operator/admin token sent with every `subscribe_dashboard` message. The API server's `/ws` endpoint requires this token to be a valid operator credential. Without it the server closes the connection with code `4401` and the dashboard shows *"Not authorized"*. |

#### Obtaining a token

Generate a token with the API server's admin CLI or via your identity provider (see `api-server/README.md`). Treat it like a password — do not commit it to version control.

```bash
cp .env.example .env.local
echo "VITE_DASHBOARD_TOKEN=<your-operator-token>" >> .env.local
```

#### Auth-rejection behaviour

If the server rejects the token (close code `4401`), the dashboard shows:

> **Not authorized** — Authorization failed. Check that VITE_DASHBOARD_TOKEN is set correctly.

It does **not** retry automatically, since retrying with a bad token would just spam the server.

---

### Install Dependencies

```bash
cd dashboard
npm install
```

### Development Server

```bash
npm run dev
```

The dashboard will be available at `http://localhost:5173`

### Build for Production

```bash
npm run build
```

### Type Check

```bash
npm run type-check
```

## Project Structure

```
src/
├── components/
│   ├── CredentialCard.tsx      # Main credential card component
│   └── index.ts                # Component exports
├── types/
│   └── credential.ts           # TypeScript types
├── styles/
│   └── credentialCard.css      # Component styles
├── App.tsx                     # Demo app
├── App.css                     # App styles
├── main.tsx                    # Entry point
└── index.css                   # Global styles
```

## CredentialCard Component

### Props

- `credential`: `Credential` - The credential data to display
- `onNavigate?`: `(credentialId: string) => void` - Callback when card is clicked
- `className?`: `string` - Additional CSS classes
- `isInteractive?`: `boolean` - Whether the card is interactive (default: true)

### Features

- ✅ Displays credential type icon with color coding
- ✅ Shows truncated credential ID
- ✅ Displays subject address
- ✅ Shows issuance date with relative time
- ✅ Status badge (Attested, Pending, Revoked)
- ✅ Keyboard navigable (Tab, Enter, Space)
- ✅ Full ARIA labels and semantic HTML
- ✅ Revoked credentials show muted styling with strikethrough
- ✅ Dark mode support
- ✅ Smooth animations with reduced-motion support

### Usage

```tsx
import { CredentialCard } from '@/components'
import { Credential } from '@/types/credential'

const credential: Credential = {
  id: '0x1234...',
  type: 'degree',
  title: 'Bachelor of Science',
  subjectAddress: '0x...',
  issuanceDate: new Date(),
  status: 'attested',
  issuer: { name: 'MIT' }
}

function CredentialList() {
  return (
    <CredentialCard
      credential={credential}
      onNavigate={(id) => navigate(`/credential/${id}`)}
    />
  )
}
```

## Accessibility

The component includes comprehensive accessibility features:

- **Keyboard Navigation**: Full tab and enter key support
- **ARIA Labels**: Proper labels on status badges and interactive elements
- **Semantic HTML**: Uses proper heading hierarchy and time elements
- **Screen Reader Support**: Descriptive labels for all interactive elements
- **Focus Indicators**: Clear visual focus indicators on keyboard navigation
- **Motion Preferences**: Respects `prefers-reduced-motion` setting
- **Color Contrast**: WCAG AA compliant color combinations

## Styling

The component uses CSS custom properties and supports both light and dark modes through:

- `prefers-color-scheme` media query detection
- Responsive grid layout
- Flexible icon sizing
- Smooth transitions (respecting motion preferences)

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile browsers (iOS Safari, Chrome Mobile)
