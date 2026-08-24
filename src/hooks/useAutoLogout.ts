import { useEffect, useRef, useState, useCallback } from 'react';
import { ToastMessage } from '../types';

interface UseAutoLogoutOptions {
  user: any;
  onLogout: () => void;
  onOpenAuth: () => void;
  addToast: (toast: Omit<ToastMessage, 'id' | 'timestamp'>) => void;
  inactivityTimeoutMinutes?: number;
}

export function useAutoLogout({
  user,
  onLogout,
  onOpenAuth,
  addToast,
  inactivityTimeoutMinutes = 15,
}: UseAutoLogoutOptions) {
  const [minutesRemaining, setMinutesRemaining] = useState(inactivityTimeoutMinutes);
  const [secondsRemaining, setSecondsRemaining] = useState(inactivityTimeoutMinutes * 60);
  const [isWarningTriggered, setIsWarningTriggered] = useState(false);
  const lastActivityRef = useRef<number>(Date.now());
  const warningToastIdRef = useRef<boolean>(false);

  const resetTimer = useCallback(() => {
    lastActivityRef.current = Date.now();
    setIsWarningTriggered(false);
    warningToastIdRef.current = false;
  }, []);

  useEffect(() => {
    // Register activity listeners
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'];
    const handleActivity = () => {
      // Throttle resets to avoid excessive state changes
      if (Date.now() - lastActivityRef.current > 3000) {
        resetTimer();
      }
    };

    events.forEach((event) => window.addEventListener(event, handleActivity));

    return () => {
      events.forEach((event) => window.removeEventListener(event, handleActivity));
    };
  }, [resetTimer]);

  useEffect(() => {
    if (!user) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const elapsedMs = now - lastActivityRef.current;
      const totalTimeoutMs = inactivityTimeoutMinutes * 60 * 1000;
      const remainingMs = Math.max(0, totalTimeoutMs - elapsedMs);
      const remainingSecs = Math.floor(remainingMs / 1000);

      setSecondsRemaining(remainingSecs);
      setMinutesRemaining(Math.ceil(remainingSecs / 60));

      // Warning when <= 30 seconds remaining
      if (remainingSecs <= 30 && remainingSecs > 0 && !warningToastIdRef.current) {
        warningToastIdRef.current = true;
        setIsWarningTriggered(true);
        addToast({
          type: 'warning',
          title: 'ENTERPRISE SECURITY COMPLIANCE WARNING',
          description: `User inactivity detected. Session will auto-terminate in ${remainingSecs}s to maintain digital twin security rules. Move cursor to extend.`,
          duration: 6000,
        });
      }

      // Trigger auto-logout when timer reaches 0
      if (remainingSecs <= 0) {
        clearInterval(interval);
        onLogout();
        addToast({
          type: 'error',
          title: 'SECURITY COMPLIANCE AUTO-LOGOUT',
          description: `Session automatically closed after ${inactivityTimeoutMinutes}m of inactivity. Please re-authenticate JWT bearer token.`,
          duration: 8000,
        });
        onOpenAuth();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [user, inactivityTimeoutMinutes, onLogout, onOpenAuth, addToast]);

  return {
    secondsRemaining,
    minutesRemaining,
    isWarningTriggered,
    resetTimer,
  };
}
