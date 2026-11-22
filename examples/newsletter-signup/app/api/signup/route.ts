import { NextResponse } from 'next/server';
import { appendSignup, isValidEmail } from '../../../lib/store';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const email =
    body && typeof body === 'object' && 'email' in body
      ? String((body as { email: unknown }).email ?? '')
      : '';

  if (!email.trim()) {
    return NextResponse.json({ error: 'email required' }, { status: 400 });
  }
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'invalid email' }, { status: 400 });
  }

  appendSignup(email.trim().toLowerCase());
  // Do not echo the address: keeps captured oracle output free of credential-shaped text.
  return NextResponse.json({ ok: true }, { status: 201 });
}
