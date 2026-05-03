import { NextResponse } from 'next/server';

import { auth } from '~/auth';

function bcBase(): string {
  const hash = process.env.BIGCOMMERCE_STORE_HASH;

  if (!hash) {
    throw new Error('Missing BIGCOMMERCE_STORE_HASH');
  }

  return `https://api.bigcommerce.com/stores/${hash}`;
}

function bcHeaders(): Record<string, string> {
  const token = process.env.BC_MANAGEMENT_TOKEN;

  if (!token) {
    throw new Error('Missing BC_MANAGEMENT_TOKEN');
  }

  return {
    'X-Auth-Token': token,
    Accept: 'application/json',
  };
}

interface BcCustomer {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
}

interface BcAddress {
  id: number;
  first_name: string;
  last_name: string;
  company: string;
  street_1: string;
  street_2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  country_iso2: string;
  phone: string;
  address_type: 'residential' | 'commercial';
}

export async function GET() {
  try {
    const session = await auth();
    const sessionEmail = session?.user?.email?.trim().toLowerCase();

    if (!sessionEmail) {
      return NextResponse.json({ authenticated: false });
    }

    const fallbackFirstName = session?.user?.firstName ?? '';
    const fallbackLastName = session?.user?.lastName ?? '';

    const customerLookupRes = await fetch(
      `${bcBase()}/v2/customers?email=${encodeURIComponent(sessionEmail)}&limit=1`,
      {
        headers: bcHeaders(),
        cache: 'no-store',
      },
    );

    if (!customerLookupRes.ok) {
      return NextResponse.json({
        authenticated: true,
        email: sessionEmail,
        firstName: fallbackFirstName,
        lastName: fallbackLastName,
        addresses: [],
      });
    }

    const customerLookupText = await customerLookupRes.text();

    if (!customerLookupText || customerLookupText.trim() === '') {
      return NextResponse.json({
        authenticated: true,
        email: sessionEmail,
        firstName: fallbackFirstName,
        lastName: fallbackLastName,
        addresses: [],
      });
    }

    let customers: BcCustomer[] = [];

    try {
      customers = JSON.parse(customerLookupText) as BcCustomer[];
    } catch {
      customers = [];
    }

    if (!Array.isArray(customers) || customers.length === 0) {
      return NextResponse.json({
        authenticated: true,
        email: sessionEmail,
        firstName: fallbackFirstName,
        lastName: fallbackLastName,
        addresses: [],
      });
    }

    const customer = customers[0]!;
    const addressRes = await fetch(`${bcBase()}/v2/customers/${customer.id}/addresses?limit=10`, {
      headers: bcHeaders(),
      cache: 'no-store',
    });

    let addresses: BcAddress[] = [];

    if (addressRes.ok) {
      const addressText = await addressRes.text();

      if (addressText && addressText.trim() !== '') {
        try {
          addresses = JSON.parse(addressText) as BcAddress[];
        } catch {
          addresses = [];
        }
      }
    }

    return NextResponse.json({
      authenticated: true,
      customerId: customer.id,
      firstName: fallbackFirstName || customer.first_name || '',
      lastName: fallbackLastName || customer.last_name || '',
      email: customer.email || sessionEmail,
      phone: customer.phone || '',
      addresses: addresses.map((address) => ({
        id: address.id,
        firstName: address.first_name,
        lastName: address.last_name,
        company: address.company,
        address1: address.street_1,
        address2: address.street_2,
        city: address.city,
        state: address.state,
        postalCode: address.zip,
        countryCode: address.country_iso2,
        country: address.country,
        phone: address.phone,
        addressType: address.address_type,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';

    return NextResponse.json({ authenticated: false, error: message }, { status: 500 });
  }
}
