import { useState } from 'react';
import { errorMessage } from '../../shared/errors';

/** One user action at a time: its label, failure and confirmation. */
export function useTask() {
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function task(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  return { busy, error, setError, notice, setNotice, task };
}
