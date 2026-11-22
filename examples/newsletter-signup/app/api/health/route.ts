import { NextResponse } from 'next/server';

/** Returns 200 when the server can accept a signup. */
export async function GET() {
  return NextResponse.json({ ok: true }, { status: 200 });
}
