import { bcManagementBase, bcManagementHeaders } from './auth';

export interface LoanApproval {
  approved: boolean;
  approvedAmount: number;
}

/**
 * Reads the merchant loan approval amount from the customer's metafields.
 * Namespace: `lending`, Key: `loan_approval`
 */
export async function fetchLoanApproval(customerId: number): Promise<LoanApproval> {
  if (!customerId || customerId <= 0) {
    return { approved: false, approvedAmount: 0 };
  }

  const url =
    `${bcManagementBase()}/customers/${encodeURIComponent(String(customerId))}/metafields` +
    `?namespace=lending&key=loan_approval`;

  const res = await fetch(url, {
    headers: bcManagementHeaders(),
    cache: 'no-store',
  });

  if (!res.ok) {
    return { approved: false, approvedAmount: 0 };
  }

  const body = (await res.json()) as { data: Array<{ value: string }> };

  if (!body.data?.length) {
    return { approved: false, approvedAmount: 0 };
  }

  const amount = parseFloat(body.data[0]!.value);

  if (isNaN(amount) || amount <= 0) {
    return { approved: false, approvedAmount: 0 };
  }

  return { approved: true, approvedAmount: amount };
}
