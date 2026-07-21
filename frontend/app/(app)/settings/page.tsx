'use client';

import { useEffect, useState } from 'react';
import { djangoClient } from '@/lib/django-client';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { User, Lock, Building2, Loader2, CreditCard, Smartphone } from 'lucide-react';

const SUB_STATUS_LABEL: Record<string, string> = {
  active: 'Actif',
  disabled: 'Désactivé',
  pending: 'En attente',
  trial: 'Essai',
  demo: 'Démo',
};

const getSubStatusBadgeClass = (status: string) => {
  switch (status) {
    case 'active': return 'bg-green-50 text-green-700';
    case 'trial': return 'bg-blue-50 text-blue-700';
    case 'demo': return 'bg-purple-50 text-purple-700';
    case 'pending': return 'bg-orange-50 text-orange-700';
    case 'disabled': return 'bg-red-50 text-red-700';
    default: return 'bg-muted text-muted-foreground';
  }
};

const REQ_STATUS_LABEL: Record<string, string> = {
  pending: 'En attente',
  approved: 'Approuvée',
  rejected: 'Rejetée',
};

const roleLabel: Record<string, string> = {
  admin: 'Administrateur',
  magasin: 'Gérant de magasin',
  employer: 'Commercial',
};

export default function SettingsPage() {
  const { user, loading: userLoading } = useCurrentUser();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPw, setChangingPw] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [shopName, setShopName] = useState('');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [updatingDetails, setUpdatingDetails] = useState(false);

  const [subscription, setSubscription] = useState<any | null>(null);
  const [myRequests, setMyRequests] = useState<any[]>([]);
  const [devices, setDevices] = useState<any[]>([]);
  const [subLoading, setSubLoading] = useState(false);
  const [requestingActivation, setRequestingActivation] = useState(false);
  const [requestingDeviceId, setRequestingDeviceId] = useState<number | null>(null);

  useEffect(() => {
    if (user) {
      setFullName(user.full_name || '');
      setPhone(user.phone || '');
      setCompanyName(user.company_name || '');
      setShopName(user.shop_name || '');
    }
  }, [user]);

  const fetchSubscriptionData = async () => {
    setSubLoading(true);
    try {
      const [sub, reqs, devs] = await Promise.all([
        djangoClient.myCompany.getSubscription(),
        djangoClient.myCompany.listRequests(),
        djangoClient.myCompany.getDevices(),
      ]);
      setSubscription(sub);
      setMyRequests(reqs);
      setDevices(devs);
    } catch (err) {
      console.error(err);
    } finally {
      setSubLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role === 'admin') fetchSubscriptionData();
  }, [user?.role]);

  const hasPendingActivationRequest = myRequests.some(
    (r) => r.request_type === 'activation' && r.status === 'pending'
  );

  const handleRequestActivation = async () => {
    setRequestingActivation(true);
    try {
      await djangoClient.myCompany.createRequest({ request_type: 'activation' });
      toast.success('Demande d\'activation envoyée à Label Technology');
      fetchSubscriptionData();
    } catch (err: any) {
      toast.error(err.message || 'Erreur lors de la demande');
    } finally {
      setRequestingActivation(false);
    }
  };

  const handleRequestDeviceDeletion = async (deviceId: number) => {
    setRequestingDeviceId(deviceId);
    try {
      await djangoClient.myCompany.createRequest({ request_type: 'device_deletion', login_event_id: deviceId });
      toast.success('Demande de suppression envoyée à Label Technology');
      fetchSubscriptionData();
    } catch (err: any) {
      toast.error(err.message || 'Erreur lors de la demande');
    } finally {
      setRequestingDeviceId(null);
    }
  };

  const pendingDeviceRequestIds = new Set(
    myRequests
      .filter((r) => r.request_type === 'device_deletion' && r.status === 'pending')
      .map((r) => r.device_info?.login_event_id)
  );

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setLogoFile(file);
      setLogoPreview(URL.createObjectURL(file));
    }
  };

  const handleUpdateDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    setUpdatingDetails(true);
    try {
      const formData = new FormData();
      if (user?.role === 'admin') {
        formData.append('company_name', companyName);
        if (logoFile) {
          formData.append('logo', logoFile);
        }
      } else if (user?.role === 'magasin') {
        formData.append('shop_name', shopName);
        if (logoFile) {
          formData.append('shop_logo', logoFile);
        }
      }

      await djangoClient.patchFormData('/users/me/', formData);
      toast.success('Informations mises à jour avec succès');
      setModalOpen(false);
      window.location.reload();
    } catch (err: any) {
      toast.error(err.message || 'Erreur lors de la mise à jour');
    } finally {
      setUpdatingDetails(false);
    }
  };

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await djangoClient.users.updateProfile({ full_name: fullName, phone });
      toast.success('Profil mis à jour');
    } catch (err: any) {
      toast.error(err.message || 'Erreur lors de la mise à jour');
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error('Les mots de passe ne correspondent pas');
      return;
    }
    if (newPassword.length < 6) {
      toast.error('Le mot de passe doit contenir au moins 6 caractères');
      return;
    }
    setChangingPw(true);
    try {
      await djangoClient.post('/users/change-password/', {
        old_password: oldPassword,
        new_password: newPassword,
      });
      toast.success('Mot de passe changé avec succès');
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      toast.error(err.message || 'Erreur lors du changement de mot de passe');
    } finally {
      setChangingPw(false);
    }
  };

  if (userLoading) {
    return (
      <div className="p-6 space-y-4">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Paramètres</h1>
        <p className="text-muted-foreground mt-1">Gérez votre profil et vos préférences</p>
      </div>

      <Tabs defaultValue="profile" className="space-y-6">
        <TabsList>
          <TabsTrigger value="profile">
            <User className="h-4 w-4 mr-2" />Mon profil
          </TabsTrigger>
          <TabsTrigger value="security">
            <Lock className="h-4 w-4 mr-2" />Sécurité
          </TabsTrigger>
          {user?.role === 'admin' && (
            <TabsTrigger value="subscription">
              <CreditCard className="h-4 w-4 mr-2" />Abonnement
            </TabsTrigger>
          )}
          {user?.role === 'admin' && (
            <TabsTrigger value="devices">
              <Smartphone className="h-4 w-4 mr-2" />Appareils
            </TabsTrigger>
          )}
        </TabsList>

        {/* Profile tab */}
        <TabsContent value="profile">
          <Card>
            <CardHeader>
              <CardTitle>Informations personnelles</CardTitle>
              <CardDescription>Mettez à jour vos informations</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleUpdateProfile} className="space-y-4 max-w-md">
                <div className="space-y-2">
                  <Label>Email</Label>
                  <Input value={user?.email || ''} disabled className="bg-muted" />
                  <p className="text-xs text-muted-foreground">L'email ne peut pas être modifié</p>
                </div>
                <div className="space-y-2">
                  <Label>Rôle</Label>
                  <div>
                    <Badge variant="outline">{roleLabel[user?.role || ''] || user?.role}</Badge>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="fullName">Nom complet</Label>
                  <Input
                    id="fullName"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Votre nom"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Téléphone</Label>
                  <Input
                    id="phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+261 XX XXX XX XX"
                  />
                </div>
                {user?.role === 'magasin' && user.shop_name && (
                  <div className="space-y-2 border-t pt-4">
                    <Label>Magasin</Label>
                    <div className="flex items-center justify-between gap-2 p-3 border rounded-lg bg-slate-50/50">
                      <div className="flex items-center gap-2 text-sm">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span className="font-semibold">{user.shop_name}</span>
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={() => setModalOpen(true)}>
                        Modifier
                      </Button>
                    </div>
                  </div>
                )}
                {user?.role === 'admin' && user.company_name && (
                  <div className="space-y-2 border-t pt-4">
                    <Label>Entreprise</Label>
                    <div className="flex items-center justify-between gap-2 p-3 border rounded-lg bg-slate-50/50">
                      <div className="flex items-center gap-2 text-sm">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span className="font-semibold">{user.company_name}</span>
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={() => setModalOpen(true)}>
                        Modifier
                      </Button>
                    </div>
                  </div>
                )}
                <Button type="submit" disabled={saving}>
                  {saving ? 'Enregistrement...' : 'Enregistrer'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Security tab */}
        <TabsContent value="security">
          <Card>
            <CardHeader>
              <CardTitle>Changer le mot de passe</CardTitle>
              <CardDescription>Sécurisez votre compte</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleChangePassword} className="space-y-4 max-w-md">
                <div className="space-y-2">
                  <Label htmlFor="oldPw">Mot de passe actuel</Label>
                  <Input
                    id="oldPw"
                    type="password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="newPw">Nouveau mot de passe</Label>
                  <Input
                    id="newPw"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="••••••••"
                    minLength={6}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirmPw">Confirmer le mot de passe</Label>
                  <Input
                    id="confirmPw"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                  />
                </div>
                <Button type="submit" disabled={changingPw}>
                  {changingPw ? 'Changement...' : 'Changer le mot de passe'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Subscription tab */}
        {user?.role === 'admin' && (
          <TabsContent value="subscription">
            <Card>
              <CardHeader>
                <CardTitle>Abonnement</CardTitle>
                <CardDescription>Statut de l'abonnement de votre société</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {subLoading && !subscription ? (
                  <Skeleton className="h-24 w-full" />
                ) : (
                  <>
                    <div className="flex items-center gap-3 flex-wrap">
                      <Badge variant="outline" className={getSubStatusBadgeClass(subscription?.status)}>
                        {SUB_STATUS_LABEL[subscription?.status] || subscription?.status}
                      </Badge>
                      {subscription?.status === 'trial' && subscription?.days_left_in_trial !== null && (
                        <span className="text-sm text-muted-foreground">
                          {subscription.days_left_in_trial} jour(s) restant(s) à l'essai
                        </span>
                      )}
                    </div>

                    {subscription?.status !== 'active' && subscription?.status !== 'demo' && (
                      <Button onClick={handleRequestActivation} disabled={requestingActivation || hasPendingActivationRequest}>
                        {hasPendingActivationRequest
                          ? 'Demande déjà envoyée'
                          : requestingActivation
                            ? 'Envoi...'
                            : "Demander l'activation"}
                      </Button>
                    )}

                    {myRequests.length > 0 && (
                      <div className="border-t pt-4 space-y-2">
                        <Label>Historique des demandes</Label>
                        {myRequests.map((r) => (
                          <div key={r.id} className="flex items-center justify-between text-sm border rounded-md p-2">
                            <span>{r.request_type === 'activation' ? "Activation d'abonnement" : "Suppression d'appareil"}</span>
                            <Badge variant="outline" className={
                              r.status === 'approved' ? 'bg-green-50 text-green-700' :
                              r.status === 'rejected' ? 'bg-red-50 text-red-700' : 'bg-orange-50 text-orange-700'
                            }>
                              {REQ_STATUS_LABEL[r.status]}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* Devices tab */}
        {user?.role === 'admin' && (
          <TabsContent value="devices">
            <Card>
              <CardHeader>
                <CardTitle>Appareils connectés</CardTitle>
                <CardDescription>Dernières connexions des comptes de votre société</CardDescription>
              </CardHeader>
              <CardContent>
                {subLoading && devices.length === 0 ? (
                  <Skeleton className="h-24 w-full" />
                ) : devices.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Aucune connexion enregistrée</p>
                ) : (
                  <div className="space-y-2">
                    {devices.map((d) => (
                      <div key={d.id} className="flex items-center justify-between border rounded-md p-3 text-sm">
                        <div>
                          <p className="font-medium">{d.user_name} <span className="text-xs text-muted-foreground">({d.user_role})</span></p>
                          <p className="text-xs text-muted-foreground truncate max-w-xs">{d.user_agent}</p>
                          <p className="text-xs text-muted-foreground font-mono">{d.ip_address}</p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={requestingDeviceId === d.id || pendingDeviceRequestIds.has(d.id)}
                          onClick={() => handleRequestDeviceDeletion(d.id)}
                        >
                          {pendingDeviceRequestIds.has(d.id)
                            ? 'Demande envoyée'
                            : requestingDeviceId === d.id
                              ? 'Envoi...'
                              : 'Demander la suppression'}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {user?.role === 'admin' ? "Modifier l'entreprise" : "Modifier le magasin"}
            </DialogTitle>
            <DialogDescription>
              {user?.role === 'admin' 
                ? "Mettez à jour le nom et le logo de votre entreprise" 
                : "Mettez à jour le nom et le logo de votre magasin"}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleUpdateDetails} className="space-y-4">
            <div className="space-y-2">
              <Label>
                {user?.role === 'admin' ? "Nom de l'entreprise" : "Nom du magasin"}
              </Label>
              <Input
                value={user?.role === 'admin' ? companyName : shopName}
                onChange={(e) => user?.role === 'admin' ? setCompanyName(e.target.value) : setShopName(e.target.value)}
                placeholder={user?.role === 'admin' ? "Nom de l'entreprise" : "Nom du magasin"}
                required
              />
            </div>
            
            <div className="space-y-2">
              <Label>
                {user?.role === 'admin' ? "Logo de l'entreprise" : "Logo du magasin"}
              </Label>
              <Input
                type="file"
                accept="image/*"
                onChange={handleLogoChange}
              />
              {logoPreview && (
                <div className="mt-2 flex justify-center">
                  <img src={logoPreview} alt="Preview" className="h-20 w-20 object-contain rounded-md border" />
                </div>
              )}
            </div>

            <div className="flex gap-2 justify-end pt-4">
              <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={updatingDetails}>
                {updatingDetails ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Enregistrement...
                  </>
                ) : (
                  'Enregistrer'
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
