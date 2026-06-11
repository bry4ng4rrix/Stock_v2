'use client';

import { useEffect, useState, useCallback } from 'react';
import { djangoClient } from '@/lib/django-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { Check, X, ShieldAlert, Users as UsersIcon, Shield, Briefcase, Plus, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';

export default function UsersPage() {
  const { user: currentUser, loading: currentUserLoading, isAdmin, isManager } = useCurrentUser();

  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [pendingUsers, setPendingUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  // Add user dialog
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [newUser, setNewUser] = useState({
    full_name: '',
    email: '',
    password: '',
    role: 'employer' as string,
    position: '',
    shop_name: '',
    company_name: '',
  });

  // Edit role dialog
  const [editRoleDialogOpen, setEditRoleDialogOpen] = useState(false);
  const [editingUserRole, setEditingUserRole] = useState<any>(null);
  const [newRoleValue, setNewRoleValue] = useState('');
  const [editRoleLoading, setEditRoleLoading] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const [storeData, pending] = await Promise.all([
        djangoClient.get<any[]>('/users/magasins/users/'),
        djangoClient.auth.getPendingUsers().catch(() => [] as any[]),
      ]);

      const flat: any[] = [];
      const seenUserIds = new Set<number>();

      const addUser = (user: any, shopName?: string, magasinId?: number) => {
        if (!user || seenUserIds.has(user.id)) return;
        seenUserIds.add(user.id);
        flat.push({ ...user, shop_name: shopName || user.shop_name || '-', magasin_id: magasinId ?? user.magasin_id ?? null });
      };

      for (const store of storeData) {
        if (store.manager) addUser(store.manager, store.shop_name, store.magasin_id);
        for (const emp of store.employers || []) addUser(emp, store.shop_name, store.magasin_id);
        for (const companyUser of store.company_users || []) addUser(companyUser, companyUser.shop_name || store.shop_name, companyUser.magasin_id ?? store.magasin_id);
      }
      setAllUsers(flat);
      setPendingUsers(pending);
    } catch (err: any) {
      toast.error('Erreur de chargement: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!currentUserLoading) fetchUsers();
  }, [currentUserLoading, fetchUsers]);

  const handleApprove = async (userId: number) => {
    try {
      await djangoClient.auth.approveUser(userId);
      toast.success('Utilisateur approuvé');
      await fetchUsers();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const handleReject = async (userId: number) => {
    if (!confirm('Rejeter et supprimer cet utilisateur ?')) return;
    try {
      await djangoClient.auth.rejectUser(userId);
      toast.success('Utilisateur rejeté');
      await fetchUsers();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const handleDelete = async (userId: number) => {
    if (!confirm('Supprimer définitivement cet utilisateur ?')) return;
    try {
      await djangoClient.users.delete(userId);
      toast.success('Utilisateur supprimé');
      await fetchUsers();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const handleUpdateRole = async () => {
    if (!editingUserRole || !newRoleValue) return;
    setEditRoleLoading(true);
    try {
      await djangoClient.put(`/users/role/${editingUserRole.id}/`, { role: newRoleValue });
      toast.success(`Rôle mis à jour : ${newRoleValue}`);
      setEditRoleDialogOpen(false);
      setEditingUserRole(null);
      setNewRoleValue('');
      await fetchUsers();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setEditRoleLoading(false);
    }
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newUser.password.length < 6) {
      toast.error('Le mot de passe doit contenir au moins 6 caractères');
      return;
    }

    setIsSubmitting(true);
    try {
      const extraData: any = {};
      if (newUser.role === 'employer') {
        extraData.position = newUser.position;
        extraData.admin_email = currentUser?.email || '';
      } else if (newUser.role === 'magasin') {
        extraData.shop_name = newUser.shop_name;
        extraData.admin_email = currentUser?.email || '';
      }

      let createdUser: any = null;

      if (newUser.role === 'admin') {
        createdUser = await djangoClient.post<any>('/users/add-admin/', {
          email: newUser.email,
          username: newUser.email,
          password: newUser.password,
          role: newUser.role,
          full_name: newUser.full_name,
        });
      } else {
        createdUser = await djangoClient.auth.register(
          newUser.email,
          newUser.email,
          newUser.password,
          newUser.role,
          { full_name: newUser.full_name, ...extraData }
        );
      }

      if (newUser.role !== 'admin') {
        toast.info('Utilisateur créé en attente d\'approbation');
      } else {
        toast.success('Administrateur créé avec succès');
      }

      if (createdUser?.id && newUser.role === 'admin') {
        setAllUsers(prev => [
          {
            id: createdUser.id,
            full_name: newUser.full_name,
            email: newUser.email,
            role: 'admin',
            shop_name: currentUser?.company_name || 'Société',
            magasin_id: null,
            position: '',
            is_confirmed: true,
          },
          ...prev,
        ]);
      }

      setIsDialogOpen(false);
      setNewUser({ full_name: '', email: '', password: '', role: 'employer', position: '', shop_name: '', company_name: '' });
      await fetchUsers();
    } catch (err: any) {
      const errorData = err?.response?.data;
      const usernameError = Array.isArray(errorData?.username) ? errorData.username.join(' ') : '';
      const emailError = Array.isArray(errorData?.email) ? errorData.email.join(' ') : '';

      if (usernameError.toLowerCase().includes('already exists') || emailError.toLowerCase().includes('already exists')) {
        toast.error('Un utilisateur avec ce nom d\'utilisateur ou cet email existe déjà.');
      } else {
        toast.error(err?.message || 'Une erreur est survenue pendant la création du compte.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredAll = allUsers.filter(u =>
    (u.full_name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    (u.email || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  const filteredPending = pendingUsers.filter(u =>
    (u.full_name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    (u.email || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getRoleIcon = (role: string) => {
    if (role === 'admin') return <Shield className="h-4 w-4 text-purple-500" />;
    if (role === 'magasin') return <Briefcase className="h-4 w-4 text-blue-500" />;
    return <UsersIcon className="h-4 w-4 text-green-500" />;
  };

  const getRoleLabel = (role: string) => ({
    admin: 'Administrateur', magasin: 'Gérant', employer: 'Employé',
  }[role] ?? role);

  if (!isManager && !currentUserLoading) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-20 text-center">
            <ShieldAlert className="h-12 w-12 text-red-500 mb-4" />
            <h2 className="text-xl font-bold">Accès Refusé</h2>
            <p className="text-muted-foreground mt-2">Vous n'avez pas les permissions pour gérer les utilisateurs.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Super Administration
          </h1>
          <p className="text-muted-foreground mt-1">Gérez les accès de votre équipe.</p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Rechercher..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="max-w-xs"
          />
          {isManager && (
            <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="h-4 w-4 mr-2" />Ajouter
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>Créer un utilisateur</DialogTitle>
                  <DialogDescription>Le compte sera créé et en attente d'approbation.</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleAddUser} className="space-y-4 pt-2">
                  <div className="space-y-2">
                    <Label>Nom complet *</Label>
                    <Input value={newUser.full_name} onChange={e => setNewUser({ ...newUser, full_name: e.target.value })} placeholder="Jean Dupont" required />
                  </div>
                  <div className="space-y-2">
                    <Label>Email *</Label>
                    <Input type="email" value={newUser.email} onChange={e => setNewUser({ ...newUser, email: e.target.value })} placeholder="jean@exemple.com" required />
                  </div>
                  <div className="space-y-2">
                    <Label>Mot de passe *</Label>
                    <Input type="password" value={newUser.password} onChange={e => setNewUser({ ...newUser, password: e.target.value })} placeholder="••••••••" minLength={6} required />
                  </div>
                  <div className="space-y-2">
                    <Label>Rôle *</Label>
                    <Select value={newUser.role} onValueChange={v => setNewUser({ ...newUser, role: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="employer">Employé / Commercial</SelectItem>
                        {isAdmin && <SelectItem value="magasin">Gérant de magasin</SelectItem>}
                        {isAdmin && <SelectItem value="admin">Administrateur</SelectItem>}
                      </SelectContent>
                    </Select>
                  </div>
                  {newUser.role === 'employer' && (
                    <div className="space-y-2">
                      <Label>Poste / Fonction</Label>
                      <Input value={newUser.position} onChange={e => setNewUser({ ...newUser, position: e.target.value })} placeholder="Ex: Vendeur" />
                    </div>
                  )}
                  {newUser.role === 'magasin' && (
                    <div className="space-y-2">
                      <Label>Nom du magasin *</Label>
                      <Input value={newUser.shop_name} onChange={e => setNewUser({ ...newUser, shop_name: e.target.value })} placeholder="Ex: Boutique Ivandry" required />
                    </div>
                  )}

                  <Button type="submit" className="w-full" disabled={isSubmitting}>
                    {isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Création...</> : 'Créer l\'utilisateur'}
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      <Tabs defaultValue="actifs">
        <TabsList>
          <TabsTrigger value="actifs">
            Utilisateurs actifs
            {allUsers.length > 0 && <Badge variant="secondary" className="ml-2">{allUsers.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="pending">
            En attente
            {pendingUsers.length > 0 && <Badge className="ml-2 bg-orange-100 text-orange-800">{pendingUsers.length}</Badge>}
          </TabsTrigger>
        </TabsList>

        {/* Active users */}
        <TabsContent value="actifs">
          <Card>
            <CardHeader>
              <CardTitle>Équipe active</CardTitle>
              <CardDescription>Utilisateurs confirmés groupés par magasin</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Utilisateur</TableHead>
                        <TableHead>Rôle</TableHead>
                        <TableHead>Magasin</TableHead>
                        <TableHead>Poste</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredAll.length === 0 ? (
                        <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Aucun utilisateur trouvé</TableCell></TableRow>
                      ) : filteredAll.map(u => (
                        <TableRow key={u.id}>
                          <TableCell>
                            <div className="font-medium">{u.full_name || 'Sans nom'}</div>
                            <div className="text-xs text-muted-foreground">{u.email}</div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {getRoleIcon(u.role)}
                              {getRoleLabel(u.role)}
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">{u.shop_name || '-'}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{u.position || '-'}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              {isAdmin && currentUser && u.id !== currentUser.id && (
                                <Button
                                  variant="outline" size="sm"
                                  className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                                  onClick={() => { setEditingUserRole(u); setNewRoleValue(u.role); setEditRoleDialogOpen(true); }}
                                >
                                  Modifier rôle
                                </Button>
                              )}
                              {isAdmin && currentUser && u.id !== currentUser.id && (
                                <Button
                                  variant="ghost" size="sm"
                                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                  onClick={() => handleDelete(u.id)}
                                >
                                  Supprimer
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Pending users */}
        <TabsContent value="pending">
          <Card>
            <CardHeader>
              <CardTitle>En attente d'approbation</CardTitle>
              <CardDescription>Comptes créés mais non encore approuvés</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
              ) : filteredPending.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-lg font-medium">Aucune demande en attente</p>
                  <p className="text-sm mt-1">Tous les utilisateurs ont été traités.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Utilisateur</TableHead>
                        <TableHead>Rôle</TableHead>
                        <TableHead>Magasin / Poste</TableHead>
                        <TableHead>Date inscription</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredPending.map(u => (
                        <TableRow key={u.id}>
                          <TableCell>
                            <div className="font-medium">{u.full_name || 'Sans nom'}</div>
                            <div className="text-xs text-muted-foreground">{u.email}</div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {getRoleIcon(u.role)}
                              {getRoleLabel(u.role)}
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {u.shop_name || u.position || '-'}
                          </TableCell>
                          <TableCell className="text-xs">
                            {u.created_at ? format(new Date(u.created_at), 'dd MMM yyyy', { locale: fr }) : '-'}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="outline" size="sm"
                                className="text-green-600 hover:text-green-700 hover:bg-green-50"
                                onClick={() => handleApprove(u.id)}
                              >
                                <Check className="h-4 w-4 mr-1" />Approuver
                              </Button>
                              <Button
                                variant="outline" size="sm"
                                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                onClick={() => handleReject(u.id)}
                              >
                                <X className="h-4 w-4 mr-1" />Rejeter
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Edit Role Dialog */}
      <Dialog open={editRoleDialogOpen} onOpenChange={setEditRoleDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Modifier le rôle</DialogTitle>
            <DialogDescription>Changer le rôle de {editingUserRole?.full_name || editingUserRole?.email}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label>Nouveau rôle</Label>
              <Select value={newRoleValue} onValueChange={setNewRoleValue}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Administrateur</SelectItem>
                  <SelectItem value="magasin">Gérant de magasin</SelectItem>
                  <SelectItem value="employer">Employé / Commercial</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setEditRoleDialogOpen(false)}>Annuler</Button>
              <Button onClick={handleUpdateRole} disabled={!newRoleValue || newRoleValue === editingUserRole?.role || editRoleLoading}>
                {editRoleLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Enregistrer
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

