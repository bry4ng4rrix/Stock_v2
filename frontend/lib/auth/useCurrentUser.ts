'use client';

import { useEffect, useState } from 'react';
import { djangoClient } from '@/lib/django-client';

export interface CurrentUser {
  id: number;
  email: string;
  role: 'admin' | 'magasin' | 'employer' | 'platform_admin';
  full_name: string;
  is_confirmed: boolean;
  phone?: string;
  company_name?: string;
  logo?: string | null;
  shop_name?: string;
  shop_logo?: string | null;
  magasin_id?: number;
  position?: string;
  store_id?: number | null;
  store_name?: string | null;
  store_logo?: string | null;
}

export function useCurrentUser() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUser = async () => {
      try {
        if (!djangoClient.isAuthenticated()) {
          setUser(null);
          setLoading(false);
          return;
        }
        const data = await djangoClient.get<any>('/users/me/');
        setUser({
          id: data.id,
          email: data.email,
          role: data.role,
          full_name: data.full_name || data.username || '',
          is_confirmed: data.is_confirmed,
          phone: data.phone || undefined,
          company_name: data.company_name || undefined,
          logo: data.logo ?? null,
          shop_name: data.shop_name || undefined,
          shop_logo: data.shop_logo ?? null,
          magasin_id: data.magasin_id || undefined,
          position: data.position || undefined,
          store_id: data.magasin_id ?? null,
          // Admin: affiche le nom/logo de la société. Magasin/employé: nom/logo du magasin.
          store_name: data.role === 'admin' ? (data.company_name ?? null) : (data.shop_name ?? null),
          store_logo: data.role === 'admin' ? (data.logo ?? null) : (data.shop_logo ?? null),
        });
      } catch (err) {
        console.error('Error fetching current user:', err);
        setUser(null);
      } finally {
        setLoading(false);
      }
    };

    fetchUser();
  }, []);

  const role = user?.role;
  return {
    user,
    loading,
    isAdmin: role === 'admin',
    isMagasin: role === 'magasin',
    isEmployer: role === 'employer',
    isSuperAdmin: role === 'admin',
    isAdminOrSuperAdmin: role === 'admin' || role === 'magasin',
    isManager: role === 'admin' || role === 'magasin',
    isPlatformOwner: role === 'platform_admin',
  };
}
