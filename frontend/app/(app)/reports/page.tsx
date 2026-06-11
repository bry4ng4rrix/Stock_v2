'use client';

import { useEffect, useState, useCallback } from 'react';
import { djangoClient } from '@/lib/django-client';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RefreshCw, TrendingUp, Package, DollarSign, ShoppingBag } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useRealtimeRefresh } from '@/lib/hooks/useRealtimeRefresh';

const fmt = (n: number) => new Intl.NumberFormat('fr-MG').format(Math.round(n));

export default function ReportsPage() {
  const { isManager } = useCurrentUser();
  const [sales, setSales] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [s, p] = await Promise.all([djangoClient.sales.list(), djangoClient.products.list()]);
      setSales(s);
      setProducts(p);
    } catch (err) {
      console.error(err);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useRealtimeRefresh(['product', 'sale'], () => fetchData(true));

  useEffect(() => { fetchData(); }, [fetchData]);

  const totalRevenue = sales.reduce((s, x) => s + Number(x.total_price || 0), 0);
  const totalQty = sales.reduce((s, x) => s + (x.quantity || 0), 0);
  const totalStock = products.reduce((s, p) => s + (p.initial_quantity || 0), 0);

  // Sales by product
  const byProduct: Record<string, number> = {};
  sales.forEach(s => {
    const name = s.product_name || 'Inconnu';
    byProduct[name] = (byProduct[name] || 0) + (s.quantity || 0);
  });
  const topProducts = Object.entries(byProduct)
    .map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);

  // Daily revenue for last 30 days
  const last30: Record<string, number> = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    last30[d.toISOString().split('T')[0]] = 0;
  }
  sales.forEach(s => {
    const day = new Date(s.sold_at).toISOString().split('T')[0];
    if (day in last30) last30[day] += Number(s.total_price || 0);
  });
  const revenueChart = Object.entries(last30).map(([date, revenue]) => ({
    date: date.slice(5),
    revenue,
  }));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Rapports</h1>
          <p className="text-muted-foreground mt-1">Analyse des ventes et du stock</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchData()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />Actualiser
        </Button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Chiffre d\'affaires', value: `${fmt(totalRevenue)} Ar`, icon: DollarSign, color: 'text-green-600' },
          { label: 'Unités vendues', value: `${fmt(totalQty)}`, icon: TrendingUp, color: 'text-blue-600' },
          { label: 'Transactions', value: sales.length, icon: ShoppingBag, color: 'text-purple-600' },
          { label: 'Produits en stock', value: `${fmt(totalStock)} u.`, icon: Package, color: 'text-orange-600' },
        ].map(({ label, value, icon: Icon, color }) => (
          <Card key={label}>
            <CardHeader className="pb-2">
              <CardTitle className={`text-sm font-medium flex items-center gap-2 ${color}`}>
                <Icon className="h-4 w-4" />{label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? <Skeleton className="h-8 w-24" /> : <div className={`text-2xl font-bold ${color}`}>{value}</div>}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Revenue chart */}
      <Card>
        <CardHeader>
          <CardTitle>Chiffre d'affaires — 30 derniers jours</CardTitle>
          <CardDescription>Évolution journalière du CA</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <Skeleton className="h-64 w-full" /> : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={revenueChart}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={4} />
                <YAxis tickFormatter={(v) => fmt(v)} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => `${fmt(v)} Ar`} />
                <Bar dataKey="revenue" fill="#3b82f6" radius={[2, 2, 0, 0]} name="CA" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Top products */}
      <Card>
        <CardHeader>
          <CardTitle>Top produits vendus</CardTitle>
          <CardDescription>Classement par quantités vendues</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <Skeleton className="h-48 w-full" /> : topProducts.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">Aucune vente enregistrée</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Produit</TableHead>
                  <TableHead className="text-right">Qté vendue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topProducts.map((p, i) => (
                  <TableRow key={p.name}>
                    <TableCell className="font-medium text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="text-right font-semibold">{p.qty}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
