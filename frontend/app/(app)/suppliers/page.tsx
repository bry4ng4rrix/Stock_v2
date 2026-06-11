'use client';

import { Truck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function SuppliersPage() {
  return (
    <div className="p-6 flex items-center justify-center min-h-[60vh]">
      <Card className="max-w-md w-full text-center">
        <CardHeader>
          <CardTitle className="flex items-center justify-center gap-2 text-muted-foreground">
            <Truck className="h-8 w-8" />Fournisseurs
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">La gestion des fournisseurs sera disponible prochainement.</p>
        </CardContent>
      </Card>
    </div>
  );
}
