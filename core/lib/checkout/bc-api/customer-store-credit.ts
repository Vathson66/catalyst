import { bcManagementBase, bcManagementHeaders } from './auth';

interface BcCustomerV2 {
  store_credit?: number | string | null;
}

function bcV2Base(): string {
  return bcManagementBase().replace(/\/v3$/, '/v2');
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

export async function fetchCustomerStoreCreditBalance(customerId: number): Promise<number> {
  const res = await fetch(`${bcV2Base()}/customers/${encodeURIComponent(String(customerId))}`, {
    headers: bcManagementHeaders(),
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();

    throw new Error(`BC customer fetch failed [${res.status}]: ${text}`);
  }

  const customer = (await res.json()) as BcCustomerV2;

  return toNumber(customer.store_credit);
}

async function postCustomerStoreCreditAdjustment(
  customerId: number,
  amount: number,
): Promise<void> {
  const roundedAmount = roundMoney(amount);

  if (roundedAmount === 0) {
    return;
  }

  const res = await fetch(
    `${bcManagementBase()}/customers/${encodeURIComponent(String(customerId))}/store_credit`,
    {
      method: 'POST',
      headers: bcManagementHeaders(),
      body: JSON.stringify({ amount: roundedAmount }),
    },
  );

  if (!res.ok) {
    const text = await res.text();

    throw new Error(`BC store credit adjustment failed [${res.status}]: ${text}`);
  }
}

export async function clearCustomerStoreCreditBalance(customerId: number): Promise<void> {
  const currentBalance = roundMoney(await fetchCustomerStoreCreditBalance(customerId));

  if (currentBalance > 0) {
    await postCustomerStoreCreditAdjustment(customerId, -currentBalance);
  }
}

export async function setCustomerStoreCreditBalance(
  customerId: number,
  amount: number,
): Promise<void> {
  const requestedAmount = roundMoney(amount);

  if (!Number.isFinite(requestedAmount) || requestedAmount < 0) {
    throw new Error('Store credit amount is invalid');
  }

  await clearCustomerStoreCreditBalance(customerId);

  if (requestedAmount > 0) {
    await postCustomerStoreCreditAdjustment(customerId, requestedAmount);
  }
}
