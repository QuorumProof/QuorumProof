import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { NotificationProvider, useNotification } from '../context/NotificationContext';

describe('NotificationContext', () => {
  it('should add a notification', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <NotificationProvider>{children}</NotificationProvider>
    );
    const { result } = renderHook(() => useNotification(), { wrapper });

    act(() => {
      result.current.addNotification({
        title: 'Test',
        message: 'Test message',
        type: 'info',
      });
    });

    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0].title).toBe('Test');
    expect(result.current.notifications[0].read).toBe(false);
  });

  it('should mark notification as read', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <NotificationProvider>{children}</NotificationProvider>
    );
    const { result } = renderHook(() => useNotification(), { wrapper });

    let notifId: string;
    act(() => {
      notifId = result.current.addNotification({
        title: 'Test',
        message: 'Test message',
        type: 'info',
      });
    });

    expect(result.current.unreadCount).toBe(1);

    act(() => {
      result.current.markAsRead(notifId!);
    });

    expect(result.current.unreadCount).toBe(0);
    expect(result.current.notifications[0].read).toBe(true);
  });

  it('should mark all as read', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <NotificationProvider>{children}</NotificationProvider>
    );
    const { result } = renderHook(() => useNotification(), { wrapper });

    act(() => {
      result.current.addNotification({
        title: 'Test 1',
        message: 'Message 1',
        type: 'info',
      });
      result.current.addNotification({
        title: 'Test 2',
        message: 'Message 2',
        type: 'success',
      });
    });

    expect(result.current.unreadCount).toBe(2);

    act(() => {
      result.current.markAllAsRead();
    });

    expect(result.current.unreadCount).toBe(0);
  });

  it('should remove notification', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <NotificationProvider>{children}</NotificationProvider>
    );
    const { result } = renderHook(() => useNotification(), { wrapper });

    let notifId: string;
    act(() => {
      notifId = result.current.addNotification({
        title: 'Test',
        message: 'Test message',
        type: 'info',
      });
    });

    expect(result.current.notifications).toHaveLength(1);

    act(() => {
      result.current.removeNotification(notifId!);
    });

    expect(result.current.notifications).toHaveLength(0);
  });

  it('should clear all notifications', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <NotificationProvider>{children}</NotificationProvider>
    );
    const { result } = renderHook(() => useNotification(), { wrapper });

    act(() => {
      result.current.addNotification({
        title: 'Test 1',
        message: 'Message 1',
        type: 'info',
      });
      result.current.addNotification({
        title: 'Test 2',
        message: 'Message 2',
        type: 'success',
      });
    });

    expect(result.current.notifications).toHaveLength(2);

    act(() => {
      result.current.clearAll();
    });

    expect(result.current.notifications).toHaveLength(0);
  });
});
