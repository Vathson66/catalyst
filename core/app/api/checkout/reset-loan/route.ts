import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const ResetLoanBodySchema = z.object({
  checkoutId: z.string().min(1).optional(),
});

export async function POST(request: NextRequest) {
  const bodyText = await request.text();
  const body = bodyText ? JSON.parse(bodyText) : {};
  const parseResult = ResetLoanBodySchema.safeParse(body);

  if (!parseResult.success) {
    return NextResponse.json({ error: 'Loan reset payload is invalid' }, { status: 400 });
  }

  return NextResponse.json({ status: 'Active', appliedAmount: 0 });
}
