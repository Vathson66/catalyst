import { BookUser, Settings } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ReactNode } from 'react';

import { Link } from '~/components/link';

interface AccountItem {
  children: ReactNode;
  description?: string;
  href: string;
  title: string;
}

const AccountItem = ({ children, title, description, href }: AccountItem) => {
  return (
    <Link
      className="flex items-center border border-gray-200 p-6 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/20"
      href={href}
    >
      {children}
      <span>
        <h3 className="text-xl font-bold lg:text-2xl">{title}</h3>
        {description ? <p>{description}</p> : null}
      </span>
    </Link>
  );
};

export default function Account() {
  const t = useTranslations('Account.Home');

  return (
    <div className="mx-auto">
      <h1 className="my-8 text-4xl font-black lg:my-8 lg:text-5xl">{t('heading')}</h1>

      <div className="mb-14 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <AccountItem href="/account/addresses" title={t('addresses')}>
          <BookUser className="me-8" size={48} strokeWidth={1.5} />
        </AccountItem>
        <AccountItem href="/account/settings" title={t('settings')}>
          <Settings className="me-8" size={48} strokeWidth={1.5} />
        </AccountItem>
      </div>
    </div>
  );
}

export const runtime = 'edge';
