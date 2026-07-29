'use client';

import { useEffect, useState, useCallback } from 'react';
import { djangoClient } from '@/lib/django-client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { KeyRound, RefreshCw, Check, X } from 'lucide-react';

const STATUS_LABEL: Record<string, string> = {
  pending: 'En attente',
  approved: 'Approuvée',
  rejected: 'Rejetée',
};

const ROLE_LABEL: Record<string, string> = {
  magasin: 'Gérant de magasin',
  employer: 'Commercial',
};

const getStatusBadgeClass = (status: string) => {
  switch (status) {
    case 'approved': return 'bg-green-50 text-green-700';
    case 'rejected': return 'bg-red-50 text-red-700';
    default: return 'bg-orange-50 text-orange-700';
  }
};

export default function PasswordRequestsPage() {
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [resolving, setResolving] = useState<number | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await djangoClient.passwordResetRequests.list(
        statusFilter === 'all' ? undefined : statusFilter
      );
      setRequests(data);
    } catch (err) {
      console.error(err);
      toast.error('Erreur lors du chargement des demandes');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleResolve = async (id: number, action: 'approve' | 'reject') => {
    setResolving(id);
    try {
      await djangoClient.passwordResetRequests.resolve(id, action);
      toast.success(action === 'approve' ? 'Demande approuvée' : 'Demande rejetée');
      fetchData();
    } catch (err: any) {
      toast.error(err.message || 'Erreur lors du traitement');
    } finally {
      setResolving(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-2">
            <KeyRound className="h-7 w-7 text-blue-600" />Réinitialisations de mot de passe
          </h1>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">
            Demandes de vos gérants de magasin et commerciaux ayant oublié leur mot de passe
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">En attente</SelectItem>
              <SelectItem value="approved">Approuvées</SelectItem>
              <SelectItem value="rejected">Rejetées</SelectItem>
              <SelectItem value="all">Toutes</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Actualiser
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : requests.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Aucune demande {statusFilter !== 'all' ? STATUS_LABEL[statusFilter]?.toLowerCase() : ''}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => (
            <Card key={r.id}>
              <CardContent className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <KeyRound className="h-5 w-5 text-violet-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-sm">
                      {r.user_name} — <span className="text-blue-700">{r.user_email}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {ROLE_LABEL[r.user_role] || r.user_role}
                      {r.magasin_name ? ` · Magasin : ${r.magasin_name}` : ''}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(r.created_at).toLocaleString('fr-FR')}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="outline" className={getStatusBadgeClass(r.status)}>
                    {STATUS_LABEL[r.status]}
                  </Badge>
                  {r.status === 'pending' && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-green-700 border-green-200"
                        disabled={resolving === r.id}
                        onClick={() => handleResolve(r.id, 'approve')}
                      >
                        <Check className="h-4 w-4 mr-1" />Approuver
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-red-700 border-red-200"
                        disabled={resolving === r.id}
                        onClick={() => handleResolve(r.id, 'reject')}
                      >
                        <X className="h-4 w-4 mr-1" />Rejeter
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
