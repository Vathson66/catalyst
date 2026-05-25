import { NextRequest, NextResponse } from 'next/server';

import { bcManagementBase, bcManagementHeaders } from '~/lib/checkout/bc-api/auth';
import { loadCheckoutSession } from '~/lib/checkout/session';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      checkoutId: string;
      consignmentId: string;
      optionId: string;
    };

    const { checkoutId, consignmentId, optionId } = body;

    if (!checkoutId || !consignmentId || !optionId) {
      return NextResponse.json(
        { error: 'checkoutId, consignmentId, and optionId are required' },
        { status: 400 },
      );
    }

    const base = bcManagementBase();
    const headers = bcManagementHeaders();

    const res = await fetch(
      `${base}/checkouts/${encodeURIComponent(checkoutId)}/consignments/${encodeURIComponent(consignmentId)}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ shipping_option_id: optionId }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `BC select shipping failed [${res.status}]: ${text}` },
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
