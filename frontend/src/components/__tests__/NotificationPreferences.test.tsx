import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { render, screen, fireEvent } from '@testing-library/react';
import { NotificationProvider, useNotification } from '../../context/NotificationContext';
import { NotificationPreferences } from '../NotificationPreferences';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <NotificationProvider>{children}</NotificationProvider>
);

describe('NotificationContext — credential event helpers (#464)', () => {
  it('notifyCredentialIssued adds a success notification', () => {
    const { result } = renderHook(() => useNotification(), { wrapper });
    act(() => { result.current.notifyCredentialIssued('cred-1', 'Engineering Degree'); });
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0].type).toBe('success');
    expect(result.current.notifications[0].eventType).toBe('issued');
    expect(result.current.notifications[0].title).toBe('Credential Issued');
    expect(result.current.notifications[0].message).toContain('Engineering Degree');
  });

  it('notifyCredentialRevoked adds an error notification', () => {
    const { result } = renderHook(() => useNotification(), { wrapper });
    act(() => { result.current.notifyCredentialRevoked('cred-2'); });
    expect(result.current.notifications[0].type).toBe('error');
    expect(result.current.notifications[0].eventType).toBe('revoked');
    expect(result.current.notifications[0].credentialId).toBe('cred-2');
  });

  it('notifyCredentialVerified adds a success notification', () => {
    const { result } = renderHook(() => useNotification(), { wrapper });
    act(() => { result.current.notifyCredentialVerified('cred-3'); });
    expect(result.current.notifications[0].type).toBe('success');
    expect(result.current.notifications[0].eventType).toBe('verified');
  });

  it('notifyCredentialDisputed adds a warning notification', () => {
    const { result } = renderHook(() => useNotification(), { wrapper });
    act(() => { result.current.notifyCredentialDisputed('cred-4'); });
    expect(result.current.notifications[0].type).toBe('warning');
    expect(result.current.notifications[0].eventType).toBe('disputed');
  });

  it('does not add notification when preference is disabled', () => {
    const { result } = renderHook(() => useNotification(), { wrapper });
    act(() => { result.current.updatePreferences({ issued: false }); });
    act(() => { result.current.notifyCredentialIssued('cred-5'); });
    expect(result.current.notifications).toHaveLength(0);
  });

  it('notifyCredentialIssued without credentialType uses fallback message', () => {
    const { result } = renderHook(() => useNotification(), { wrapper });
    act(() => { result.current.notifyCredentialIssued('cred-6'); });
    expect(result.current.notifications[0].message).toContain('cred-6');
  });
});

describe('NotificationPreferences component (#464)', () => {
  it('renders all four event type checkboxes', () => {
    render(
      <NotificationProvider>
        <NotificationPreferences />
      </NotificationProvider>
    );
    expect(screen.getByLabelText(/Enable Credential Issued/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Enable Credential Revoked/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Enable Credential Verified/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Enable Credential Disputed/i)).toBeInTheDocument();
  });

  it('all checkboxes are checked by default', () => {
    render(
      <NotificationProvider>
        <NotificationPreferences />
      </NotificationProvider>
    );
    const checkboxes = screen.getAllByRole('checkbox');
    checkboxes.forEach((cb) => expect(cb).toBeChecked());
  });

  it('unchecking a preference updates the checkbox state', () => {
    render(
      <NotificationProvider>
        <NotificationPreferences />
      </NotificationProvider>
    );
    const revokedCheckbox = screen.getByLabelText(/Enable Credential Revoked/i);
    fireEvent.click(revokedCheckbox);
    expect(revokedCheckbox).not.toBeChecked();
  });
});
