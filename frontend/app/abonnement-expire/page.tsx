import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Mail, Wallet, ArrowLeft } from 'lucide-react';

export const metadata = {
  title: 'Abonnement expiré - E-kajy Entana',
};

const SUPPORT_EMAIL = 'contact@labeltechnology.mg';

export default function SubscriptionExpiredPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted p-4">
      <Card className="w-full max-w-md shadow-xl border-orange-200">
        <CardHeader className="text-center space-y-3">
          <div className="mx-auto w-14 h-14 rounded-full bg-orange-100 flex items-center justify-center">
            <AlertTriangle className="h-7 w-7 text-orange-600" />
          </div>
          <CardTitle className="text-2xl">Votre abonnement a expiré</CardTitle>
          <CardDescription>
            L'accès à votre espace est temporairement suspendu. Contactez Label Technology pour
            réactiver votre abonnement, ou réglez directement votre facture ci-dessous.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="flex items-center gap-3 p-3 border rounded-lg hover:bg-muted transition-colors"
          >
            <Mail className="h-5 w-5 text-blue-600 shrink-0" />
            <div>
              <p className="text-sm font-medium">Contacter Label Technology</p>
              <p className="text-sm text-muted-foreground">{SUPPORT_EMAIL}</p>
            </div>
          </a>

          <div className="flex items-start gap-3 p-3 border rounded-lg">
            <Wallet className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium">Paiement direct</p>
              {/* TODO: remplacer par les coordonnées de paiement réelles (Mobile Money / RIB) */}
              <p className="text-sm text-muted-foreground">
                Modalités de paiement à venir — contactez-nous à {SUPPORT_EMAIL} pour les détails.
              </p>
            </div>
          </div>

          <Button asChild variant="outline" className="w-full">
            <Link href="/login">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Retour à la connexion
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
