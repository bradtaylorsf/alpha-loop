'use client';

import { useState, type FormEvent } from 'react';

export default function NewsletterPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setStatus('idle');
    setMessage('');
    const response = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (response.ok) {
      setStatus('ok');
      setMessage('Signed up.');
      setEmail('');
      return;
    }
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    setStatus('error');
    setMessage(body.error || `Signup failed (${response.status})`);
  }

  return (
    <main>
      <h1>Newsletter signup</h1>
      <p>Submit an email address to join the list.</p>
      <form onSubmit={onSubmit} style={{ display: 'flex', gap: '0.5rem', maxWidth: 420 }}>
        <label htmlFor="email" style={{ position: 'absolute', left: -9999 }}>
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          style={{ flex: 1, padding: '0.5rem' }}
        />
        <button type="submit">Sign up</button>
      </form>
      {message ? (
        <p role="status" style={{ color: status === 'ok' ? 'green' : 'crimson' }}>
          {message}
        </p>
      ) : null}
    </main>
  );
}
