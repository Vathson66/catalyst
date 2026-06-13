import { NextRequest, NextResponse } from 'next/server';

import { bcManagementBase, bcManagementHeaders } from '~/lib/checkout/bc-api/auth';
import { loadCheckoutSession } from '~/lib/checkout/session';

interface BcCheckoutBillingResponse {
  data?: { billing_address?: { id?: string } };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      checkoutId: string;
      address: {
        firstName: string;
        lastName: string;
        email?: string;
        phone?: string;
        address1: string;
        address2?: string;
        city: string;
        stateOrProvinceCode: string;
        postalCode: string;
        countryCode: string;
      };
    };

    const { checkoutId, address } = body;

    if (!checkoutId || !address) {
      return NextResponse.json({ error: 'checkoutId and address are required' }, { status: 400 });
    }

    const base = bcManagementBase();
    const headers = bcManagementHeaders();

    const bcAddress = {
      first_name: address.firstName,
      last_name: address.lastName,
      email: address.email ?? '',
      phone: address.phone ?? '',
      address1: address.address1,
      address2: address.address2 ?? '',
      city: address.city,
      state_or_province_code: address.stateOrProvinceCode,
      postal_code: address.postalCode,
      country_code: address.countryCode,
    };

    // Check if billing address already exists (PUT vs POST)
    const checkoutRes = await fetch(`${base}/checkouts/${encodeURIComponent(checkoutId)}`, {
      headers,
      cache: 'no-store',
    });

    let existingBillingId: string | undefined;
    if (checkoutRes.ok) {
      const data = (await checkoutRes.json()) as BcCheckoutBillingResponse;
      existingBillingId = data.data?.billing_address?.id;
    }

    const url = existingBillingId
      ? `${base}/checkouts/${encodeURIComponent(checkoutId)}/billing-address/${existingBillingId}`
      : `${base}/checkouts/${encodeURIComponent(checkoutId)}/billing-address`;

    const res = await fetch(url, {
      method: existingBillingId ? 'PUT' : 'POST',
      headers,
      body: JSON.stringify(bcAddress),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `BC billing address failed [${res.status}]: ${text}` },
        { status: res.status },
      );
    }

    const session = await loadCheckoutSession(checkoutId);

    return NextResponse.json({ success: true, session });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
