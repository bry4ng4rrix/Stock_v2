'use client';

import { useEffect, useState, useCallback } from 'react';
import { djangoClient } from '@/lib/django-client';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Shield, Users, Store, RefreshCw, Trash2 } from 'lucide-react';

const roleLabel: Record<string, string> = {
  admin: 'Administrateur',
  magasin: 'Gérant',
  employer: 'Commercial',
};

export default function SuperAdminPage() {
  const { isSuperAdmin, loading: userLoading } = useCurrentUser();
  const router = useRouter();
  const [stores, setStores] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [changingRole, setChangingRole] = useState<number | null>(null);

  useEffect(() => {
    if (!userLoading && !isSuperAdmin) {
      router.replace('/dashboard');
    }
  }, [isSuperAdmin, userLoading, router]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await djangoClient.get<any[]>('/users/magasins/users/');
      setStores(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isSuperAdmin) fetchData();
  }, [isSuperAdmin, fetchData]);

  const allUsers = stores.flatMap(s => [
    s.manager ? { ...s.manager, shop_name: s.shop_name } : null,
    ...(s.employers || []).map((e: any) => ({ ...e, shop_name: s.shop_name })),
  ]).filter(Boolean);

    setChangingRole(userId);
    try {
      await djangoClient.put(`/users/role/${userId}/`, { role: newRole });
      toast.success('Rôle modifié');
      fetchData();
    } catch (err: any) {
      toast.error(err.message || 'Erreur');
    } finally {
      setChangingRole(null);
    }
  };

  const handleDelete = async (userId: number, name: string) => {
    if (!confirm(`Supprimer ${name} ?`)) return;
    try {
      await djangoClient.delete(`/users/delete/${userId}/`);
      toast.success('Utilisateur supprimé');
      fetchData();
    } catch (err: any) {
      toast.error(err.message || 'Erreur');
    }
  };

  if (userLoading || loading) {
    return (
      <div className="p-6 space-y-4">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Shield className="h-8 w-8 text-blue-600" />Super Administration
          </h1>
          <p className="text-muted-foreground mt-1">Gestion globale des utilisateurs et magasins</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />Actualiser
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Store className="h-4 w-4 text-blue-500" />Magasins</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{stores.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Users className="h-4 w-4 text-green-500" />Utilisateurs total</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{allUsers.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Users className="h-4 w-4 text-orange-500" />En attente</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{allUsers.filter((u: any) => !u.is_confirmed).length}</div></CardContent>
        </Card>
      </div>

      {/* All users table */}
      <Card>
        <CardHeader>
          <CardTitle>Tous les utilisateurs</CardTitle>
          <CardDescription>{allUsers.length} compte(s) enregistré(s)</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Magasin</TableHead>
                <TableHead>Rôle</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allUsers.map((u: any) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.full_name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{u.email}</TableCell>
                  <TableCell className="text-sm">{u.shop_name || '-'}</TableCell>
                  <TableCell>
                    <Select
                      value={u.role}
                      onValueChange={(v) => handleChangeRole(u.id, v)}
                      disabled={changingRole === u.id}
                    >
                      <SelectTrigger className="w-32 h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">Admin</SelectItem>
                        <SelectItem value="magasin">Gérant</SelectItem>
                        <SelectItem value="employer">Commercial</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={u.is_confirmed ? 'text-green-700 border-green-200' : 'text-orange-700 border-orange-200'}>
                      {u.is_confirmed ? 'Actif' : 'En attente'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-red-500 hover:text-red-700"
                      onClick={() => handleDelete(u.id, u.full_name)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
