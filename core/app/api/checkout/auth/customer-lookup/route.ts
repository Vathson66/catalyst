/**
 * POST /api/checkout/auth/customer-lookup
 *
 * Checks if a BC customer account exists for the given email address.
 * Server-side only — Management API token never exposed to the browser.
 */
import { NextRequest, NextResponse } from 'next/server';

function bcBase(): string {
  const hash = process.env.BC_STORE_HASH;
  if (!hash) throw new Error('Missing BC_STORE_HASH');
  return `https://api.bigcommerce.com/stores/${hash}`;
}

function bcHeaders(): Record<string, string> {
  const token = process.env.BC_MANAGEMENT_TOKEN;
  if (!token) throw new Error('Missing BC_MANAGEMENT_TOKEN');
  return { 'X-Auth-Token': token, Accept: 'application/json' };
}

interface BcCustomer {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { email?: string };
    const email = body.email?.trim().toLowerCase();

    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
    }

    const res = await fetch(
      `${bcBase()}/v2/customers?email=${encodeURIComponent(email)}&limit=1`,
      { headers: bcHeaders(), cache: 'no-store' },
    );

    if (!res.ok) {
      return NextResponse.json({ found: false });
    }

    const text = await res.text();
    if (!text || text.trim() === '') {
      return NextResponse.json({ found: false });
    }

    let data: BcCustomer[];
    try {
      data = JSON.parse(text) as BcCustomer[];
    } catch {
      return NextResponse.json({ found: false });
    }

    if (!Array.isArray(data) || data.length === 0) {
      return NextResponse.json({ found: false });
    }

    const customer = data[0]!;
    return NextResponse.json({
      found: true,
      customerId: customer.id,
      firstName: customer.first_name,
      lastName: customer.last_name,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
