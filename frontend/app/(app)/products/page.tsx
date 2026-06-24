'use client';

import { useEffect, useState, useCallback, useRef, useMemo, DragEvent, ChangeEvent } from 'react';
import Link from 'next/link';
import { djangoClient } from '@/lib/django-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  Plus, Download, Pencil, Trash2, X, ImagePlus, Upload, Loader2, AlertTriangle, QrCode, ShoppingCart, ArrowLeftRight, Eye,
} from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  TransferProductsDialog,
  type TransferCartItem,
} from '@/components/transfer-products-dialog';
import { toast } from 'sonner';
import { useRealtimeRefresh } from '@/lib/hooks/useRealtimeRefresh';
import { generateSimpleQRCode } from '@/lib/qrcode-generator';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import * as XLSX from 'xlsx';

const MEDIA_BASE = (process.env.NEXT_PUBLIC_DJANGO_API_URL || 'http://157.173.103.147:8000/api' || 'http://localhost:8000/api')
  .replace('/api', '');

const CATEGORIES = [
  'Sweet', 'Abaya ','Chaussure', 'Veste', 'Cheveux', 'Chemise', 'Tee shirt', 'Short', 'Ceinture', 'Pantalon', 'Jupe', 'Robe', 'Sac', 'Produit Cosmetique',
  'Sandale', 'Claquette', 'Alimentaire', 'Parfum', 'Accessoire', 'Autre'
];



function getStatus(p: any) {
  const qty = p.initial_quantity ?? 0;
  const threshold = p.alert_threshold ?? 0;
  if (qty === 0) return 'out_of_stock';
  if (qty <= threshold) return 'low';
  return 'in_stock';
}

function getExpiryInfo(expiryDate: string | null) {
  if (!expiryDate) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const expiry = new Date(expiryDate);
  const days = Math.ceil((expiry.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return { days, label: 'Périmé', cls: 'bg-red-100 text-red-800', icon: true };
  if (days <= 7) return { days, label: `${days}j !`, cls: 'bg-red-100 text-red-800', icon: true };
  if (days <= 30) return { days, label: `${days}j`, cls: 'bg-orange-100 text-orange-800', icon: false };
  return { days, label: `${days}j`, cls: 'bg-green-100 text-green-800', icon: false };
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function imageUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  return `${MEDIA_BASE}${path}`;
}

const EMPTY_FORM = {
  reference: '', name: '', brand: '', description: '', category: '',
  shell_price: '', unit_price: '', magasin: '', initial_quantity: '0', alert_threshold: '5',
  expiry_date: '',
  image1: null,
  image2: null,
  image3: null,
  qr_code: null,
  variants: [] as { size: string; color: string; quantity: number }[],
};

export default function ProductsPage() {
  const { isAdmin, isManager, user } = useCurrentUser();
  const canCreate = isManager;
  const canEdit = isAdmin;
  const canDelete = isAdmin;

  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [stores, setStores] = useState<any[]>([]);
  const [storesLoading, setStoresLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedStatus, setSelectedStatus] = useState('all');
  const [selectedStoreId, setSelectedStoreId] = useState('all');
  const [selectedProductIds, setSelectedProductIds] = useState<Set<number>>(new Set());
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [transferInitialCart, setTransferInitialCart] = useState<TransferCartItem[]>([]);

  const connectedMagasinId = user?.magasin_id ?? user?.store_id;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [previewProduct, setPreviewProduct] = useState<any | null>(null);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);

  const [importing, setImporting] = useState(false);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importMagasinId, setImportMagasinId] = useState('');
  const [importStoreFilter, setImportStoreFilter] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<any>(null);
  const [editSaving, setEditSaving] = useState(false);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingProduct, setDeletingProduct] = useState<any>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [addStockDialogOpen, setAddStockDialogOpen] = useState(false);
  const [addingProduct, setAddingProduct] = useState<any>(null);
  const [variantsDialogProduct, setVariantsDialogProduct] = useState<any | null>(null);
  const [addAmount, setAddAmount] = useState<number | string>(0);
  const [addLoading, setAddLoading] = useState(false);
  const [cartItems, setCartItems] = useState<any[]>([]);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutCustomer, setCheckoutCustomer] = useState('');
  const [checkoutIsPaid, setCheckoutIsPaid] = useState(true);
  const [checkoutPaymentAmount, setCheckoutPaymentAmount] = useState('');
  const [checkoutDueDate, setCheckoutDueDate] = useState('');
  const [checkoutSubmitting, setCheckoutSubmitting] = useState(false);

  const cartCount = cartItems.reduce((sum, item) => sum + (item.quantity ?? 0), 0);
  const cartTotal = cartItems.reduce((sum, item) => sum + Number(item.shell_price || 0) * (item.quantity ?? 1), 0);
  const checkoutDueInfo = !checkoutIsPaid && checkoutDueDate ? (() => {
    const due = new Date(checkoutDueDate);
    const today = new Date();
    const diffDays = Math.ceil((today.getTime() - due.getTime()) / 86_400_000);
    return {
      due,
      daysLate: diffDays,
      isOverdue: diffDays >= 0,
      daysUntil: Math.max(0, Math.ceil((due.getTime() - today.getTime()) / 86_400_000)),
    };
  })() : null;

  const expiringProducts = products
    .filter(p => p.expiry_date)
    .map(p => ({ ...p, expiryInfo: getExpiryInfo(p.expiry_date)! }))
    .filter(p => p.expiryInfo && p.expiryInfo.days <= 30)
    .sort((a, b) => a.expiryInfo.days - b.expiryInfo.days);

  const fetchData = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const filters: { magasin_id?: number } = {};
      if (isAdmin) {
        if (selectedStoreId !== 'all') {
          filters.magasin_id = Number(selectedStoreId);
        }
      } else if (connectedMagasinId) {
        filters.magasin_id = Number(connectedMagasinId);
      }
      const data = await djangoClient.products.list(
        Object.keys(filters).length ? filters : undefined,
      );
      setProducts(data);
    } catch (err: any) {
      if (!silent) toast.error('Erreur de chargement des produits: ' + err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [isAdmin, selectedStoreId, connectedMagasinId]);

  useRealtimeRefresh(['product', 'sale', 'movement'], () => fetchData(true));

  const fetchStores = useCallback(async () => {
    if (!isAdmin) return;
    setStoresLoading(true);
    try {
      const data = await djangoClient.get<any[]>('/users/magasins/users/');
      setStores(data);
    } catch (err: any) {
      toast.error('Erreur de chargement des magasins: ' + (err.message || err));
    } finally {
      setStoresLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    if (isAdmin) fetchStores();
  }, [isAdmin, fetchStores]);
  useEffect(() => {
    if (isAdmin && dialogOpen && stores.length === 0) {
      fetchStores();
    }
  }, [isAdmin, dialogOpen, stores.length, fetchStores]);

  useEffect(() => {
    setSelectedProductIds(new Set());
  }, [selectedStoreId]);

  const sourceStoreForTransfer = useMemo(() => {
    if (!isAdmin || selectedStoreId === 'all') return null;
    const store = stores.find((s) => String(s.magasin_id) === selectedStoreId);
    if (!store) return null;
    return {
      magasin_id: store.magasin_id,
      shop_name: store.shop_name,
      shop_logo: store.shop_logo,
    };
  }, [isAdmin, selectedStoreId, stores]);

  const filteredProducts = products.filter(p => {
    const status = getStatus(p);
    const matchSearch = (p.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.reference || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.brand || '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchCat = selectedCategory === 'all' || p.category === selectedCategory;
    const matchStatus = selectedStatus === 'all' || status === selectedStatus;
    return matchSearch && matchCat && matchStatus;
  });

  const statusColor = (s: string) => ({
    in_stock: 'bg-green-100 text-green-800',
    low: 'bg-orange-100 text-orange-800',
    out_of_stock: 'bg-red-100 text-red-800',
  }[s] ?? '');
  const statusLabel = (s: string) => ({ in_stock: 'En stock', low: 'Faible', out_of_stock: 'Rupture' }[s] ?? s);

  const toggleProductSelection = (id: number) => {
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllProducts = () => {
    if (selectedProductIds.size === filteredProducts.length && filteredProducts.length > 0) {
      setSelectedProductIds(new Set());
    } else {
      setSelectedProductIds(new Set(filteredProducts.map((p) => p.id)));
    }
  };

  const handleOpenTransfer = () => {
    if (!sourceStoreForTransfer) {
      toast.error('Sélectionnez d\'abord un magasin source dans le filtre');
      return;
    }
    if (selectedProductIds.size === 0) {
      toast.error('Sélectionnez au moins un produit à transférer');
      return;
    }
    const cart = filteredProducts
      .filter((p) => selectedProductIds.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        reference: p.reference,
        quantity: 1,
        maxQuantity: Number(p.initial_quantity ?? 0),
      }))
      .filter((p) => p.maxQuantity > 0);
    if (cart.length === 0) {
      toast.error('Les produits sélectionnés n\'ont pas de stock disponible');
      return;
    }
    setTransferInitialCart(cart);
    setTransferDialogOpen(true);
  };

  const handleTransferSuccess = () => {
    setSelectedProductIds(new Set());
    fetchData();
  };

  const SIZE_COLS = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'] as const;

  const handleExportExcel = () => {
    const rows: Record<string, any>[] = [];

    for (const p of products) {
      const base: Record<string, any> = {
        'Nom du produit': p.name,
        'Référence': p.reference,
        'Catégorie': p.category || '',
        'Marque': p.brand || '',
        'Description': p.description || '',
        'Prix vente (Ar)': p.shell_price,
        'Prix achat (Ar)': isAdmin ? (p.unit_price ?? '') : '',
        'Seuil alerte': p.alert_threshold ?? 5,
        'Date péremption': p.expiry_date || '',
      };

      const variants: any[] = p.variants ?? [];

      if (variants.length > 0) {
        // Group by color -> one row per color, sizes as columns
        const byColor = new Map<string, Record<string, number>>();
        for (const v of variants) {
          const color = (v.color || '').trim();
          if (!byColor.has(color)) byColor.set(color, {});
          const sizeKey = (v.size || '').toUpperCase();
          if (sizeKey) byColor.get(color)![sizeKey] = (byColor.get(color)![sizeKey] ?? 0) + v.quantity;
        }
        for (const [color, sizeQtys] of byColor) {
          const row: Record<string, any> = { ...base, 'Couleur': color, 'Quantité': '' };
          for (const s of SIZE_COLS) row[s] = sizeQtys[s] ?? '';
          rows.push(row);
        }
      } else {
        // No variants — single row with direct quantity
        const row: Record<string, any> = { ...base, 'Couleur': '', 'Quantité': p.initial_quantity ?? 0 };
        for (const s of SIZE_COLS) row[s] = '';
        rows.push(row);
      }
    }

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Produits');
    XLSX.writeFile(wb, `produits_${new Date().toISOString().split('T')[0]}.xlsx`);
    toast.success('Export Excel réussi !');
  };

  const parseExcelDate = (value: any) => {
    if (value == null) return '';
    const str = String(value).trim();
    if (!str) return '';
    const date = new Date(str);
    if (isNaN(date.getTime())) return '';
    return date.toISOString().split('T')[0];
  };

  const handleImportExcel = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      toast.error('Sélectionnez un fichier Excel (.xlsx ou .xls)');
      event.target.value = '';
      return;
    }

    setImporting(true);
    setImportErrors([]);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      if (workbook.SheetNames.length === 0) throw new Error('Le fichier Excel ne contient aucune feuille.');
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet, { defval: '' });
      if (rows.length === 0) throw new Error('Aucune ligne détectée dans le fichier Excel.');

      const requiredHeaders = ['Nom du produit', 'Référence', 'Catégorie', 'Prix vente (Ar)'];
      const rowHeaders = Object.keys(rows[0]).map(h => String(h).trim());
      const missingHeader = requiredHeaders.find(h => !rowHeaders.includes(h));
      if (missingHeader) throw new Error(`Colonne requise manquante : ${missingHeader}`);

      // Group rows by (reference + name) so multiple color rows -> same product with all variants
      type PendingProduct = {
        name: string; reference: string; category: string; brand: string;
        description: string; shell_price: string; unit_price: string;
        alert_threshold: string; expiry_date: string; magasin: string;
        variants: { size: string; color: string; quantity: number }[];
        directQty: number;
        resolvedQty: number;
        line: number;
      };

      const productMap = new Map<string, PendingProduct>();

      const errors: string[] = [];
      const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];

      for (let idx = 0; idx < rows.length; idx++) {
        const row = rows[idx];
        const line = idx + 2;
        const name = String(row['Nom du produit'] ?? '').trim();
        const reference = String(row['Référence'] ?? '').trim();
        const category = String(row['Catégorie'] ?? '').trim();
        const shell_price = String(row['Prix vente (Ar)'] ?? '').trim();
        const unit_price = String(row['Prix achat (Ar)'] ?? '').trim();
        const brand = String(row['Marque'] ?? '').trim();
        const description = String(row['Description'] ?? '').trim();
        const alert_threshold = String(row['Seuil alerte'] ?? '5').trim() || '5';
        const expiry_date = parseExcelDate(row['Date péremption'] ?? '');
        const color = String(row['Couleur'] ?? '').trim();
        const directQty = Number(String(row['Quantité'] ?? '0').trim()) || 0;

        if (!name || !reference || !category || !shell_price) {
          errors.push(`Ligne ${line} : champs obligatoires manquants (Nom, Référence, Catégorie, Prix vente)`);
          continue;
        }

        const key = `${reference}__${name}`;
        if (!productMap.has(key)) {
          productMap.set(key, {
            name, reference, category, brand, description,
            shell_price, unit_price, alert_threshold, expiry_date,
            magasin: importMagasinId,
            variants: [], directQty: 0, resolvedQty: 0, line,
          });
        }
        const prod = productMap.get(key)!;

        // Collect size variants for this color row
        let sizeSum = 0;
        let hadSize = false;
        for (const size of SIZES) {
          const qty = Number(String(row[size] ?? '').trim()) || 0;
          if (qty > 0) {
            prod.variants.push({ size, color, quantity: qty });
            hadSize = true;
            sizeSum += qty;
          }
        }

        if (hadSize) {
          // Sizes present: explicit Quantité takes priority; otherwise auto-sum from sizes
          prod.resolvedQty += directQty > 0 ? directQty : sizeSum;
        } else if (directQty > 0) {
          // No sizes: use manual Quantité value
          if (color) {
            prod.variants.push({ size: '', color, quantity: directQty });
          } else {
            prod.directQty += directQty;
          }
          prod.resolvedQty += directQty;
        }
      }

      let importedCount = 0;
      for (const [, prod] of productMap) {
        const fd = new FormData();
        fd.append('name', prod.name);
        fd.append('reference', prod.reference);
        fd.append('category', prod.category);
        fd.append('shell_price', prod.shell_price);
        fd.append('unit_price', prod.unit_price || prod.shell_price);
        fd.append('alert_threshold', prod.alert_threshold);
        if (prod.brand) fd.append('brand', prod.brand);
        if (prod.description) fd.append('description', prod.description);
        if (prod.expiry_date) fd.append('expiry_date', prod.expiry_date);
        if (isAdmin && prod.magasin) fd.append('magasin', prod.magasin);

        if (prod.variants.length > 0) {
          fd.append('variants', JSON.stringify(prod.variants));
          // Pass resolved total so backend respects explicit Quantité over auto-sum
          fd.append('initial_quantity', String(prod.resolvedQty || 0));
        } else {
          fd.append('initial_quantity', String(prod.directQty || 0));
        }

        try {
          await djangoClient.postFormData('/users/products/', fd);
          importedCount += 1;
        } catch (err: any) {
          errors.push(`Ligne ${prod.line} (${prod.name}) : ${err.message || 'Erreur API'}`);
        }
      }

      await fetchData();
      if (importedCount > 0) toast.success(`${importedCount} produit(s) importé(s) avec QR codes générés`);
      if (errors.length > 0) setImportErrors(errors);
    } catch (err: any) {
      toast.error(err.message || "Erreur lors de l'import Excel");
    } finally {
      setImporting(false);
      event.target.value = '';
    }
  };

  const openImportDialog = () => {
    if (isAdmin) {
      setImportMagasinId('');
      setImportStoreFilter('');
      setImportDialogOpen(true);
      if (stores.length === 0) fetchStores();
    } else {
      fileInputRef.current?.click();
    }
  };

  const confirmImportStore = () => {
    if (!importMagasinId) {
      toast.error('Veuillez sélectionner un magasin');
      return;
    }
    setImportDialogOpen(false);
    setTimeout(() => fileInputRef.current?.click(), 50);
  };

  const handleAddProduct = async () => {
    if (!form.reference || !form.name || !form.category || !form.shell_price) {
      toast.error('Veuillez remplir les champs obligatoires (Référence, Nom, Catégorie, Prix de vente)');
      return;
    }
    if (!form.unit_price) {
      toast.error("Veuillez renseigner le prix d'achat.");
      return;
    }
    if (isAdmin && !form.magasin) {
      toast.error('Veuillez sélectionner un magasin.');
      return;
    }
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('reference', form.reference);
      fd.append('name', form.name);
      fd.append('category', form.category);
      fd.append('shell_price', form.shell_price);
      fd.append('unit_price', form.unit_price);
      fd.append('initial_quantity', form.initial_quantity || '0');
      fd.append('alert_threshold', form.alert_threshold || '5');
      if (form.brand) fd.append('brand', form.brand);
      if (form.description) fd.append('description', form.description);
      if (form.expiry_date) fd.append('expiry_date', form.expiry_date);
      if (form.variants && form.variants.length > 0) {
        fd.append('variants', JSON.stringify(form.variants));
      }
      if (isAdmin && form.magasin) {
        fd.append('magasin', String(form.magasin));
      }
      const image1File = form.image1 as File | null;
      const image2File = form.image2 as File | null;
      const image3File = form.image3 as File | null;
      const qrCodeFile = form.qr_code as File | null;
      if (image1File instanceof File) fd.append('image1', image1File);
      if (image2File instanceof File) fd.append('image2', image2File);
      if (image3File instanceof File) fd.append('image3', image3File);
      if (qrCodeFile instanceof File) fd.append('qr_code', qrCodeFile);

      await djangoClient.postFormData('/users/products/', fd);
      toast.success('Produit ajouté avec succès');
      setForm({ ...EMPTY_FORM });
      setDialogOpen(false);
      await fetchData();
    } catch (err: any) {
      toast.error(err.message ?? 'Erreur lors de l\'ajout');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateProduct = async () => {
    if (!editingProduct) return;
    setEditSaving(true);
    try {
      const fd = new FormData();
      fd.append('name', editingProduct.name);
      fd.append('reference', editingProduct.reference);
      fd.append('category', editingProduct.category);
      fd.append('shell_price', String(editingProduct.shell_price));
      fd.append('alert_threshold', String(editingProduct.alert_threshold ?? 5));
      fd.append('initial_quantity', String(editingProduct.initial_quantity ?? 0));
      if (editingProduct.brand) fd.append('brand', editingProduct.brand);
      if (editingProduct.description) fd.append('description', editingProduct.description);
      if (editingProduct.expiry_date) fd.append('expiry_date', editingProduct.expiry_date);
      fd.append('variants', JSON.stringify(editingProduct.variants ?? []));
      if (editingProduct.unit_price) fd.append('unit_price', String(editingProduct.unit_price));
      const editImage1File = editingProduct.image1 as File | null;
      const editImage2File = editingProduct.image2 as File | null;
      const editImage3File = editingProduct.image3 as File | null;
      const editQrCodeFile = editingProduct.qr_code as File | null;
      if (editImage1File instanceof File) fd.append('image1', editImage1File);
      if (editImage2File instanceof File) fd.append('image2', editImage2File);
      if (editImage3File instanceof File) fd.append('image3', editImage3File);
      if (editQrCodeFile instanceof File) fd.append('qr_code', editQrCodeFile);

      await djangoClient.patchFormData(`/users/products/${editingProduct.id}/`, fd);
      toast.success('Produit modifié');
      setEditDialogOpen(false);
      await fetchData();
    } catch (err: any) {
      toast.error(err.message ?? 'Erreur lors de la modification');
    } finally {
      setEditSaving(false);
    }
  };

  const handleAddToCart = (product: any) => {
    setCartItems((prev) => {
      const existing = prev.find((item) => item.id === product.id);
      if (existing) {
        return prev.map((item) => item.id === product.id ? { ...item, quantity: (item.quantity ?? 1) + 1 } : item);
      }
      return [...prev, { ...product, quantity: 1 }];
    });
    toast.success(`${product.name} ajouté au panier`);
  };

  const handleRemoveCartItem = (productId: number) => {
    setCartItems((prev) => prev.filter((item) => item.id !== productId));
  };

  const handleCheckout = async (e: any) => {
    e.preventDefault();
    if (cartItems.length === 0) {
      toast.error('Le panier est vide.');
      return;
    }
    if (!checkoutCustomer) {
      toast.error('Veuillez renseigner le nom du client.');
      return;
    }

    setCheckoutSubmitting(true);
    try {
      await Promise.all(cartItems.map((item) => {
        const payload: any = {
          product: item.id,
          quantity: item.quantity ?? 1,
          sale_price: Number(item.shell_price || 0),
          customer_name: checkoutCustomer,
          is_paid: checkoutIsPaid,
        };
        const paymentAmountValue = parseFloat(checkoutPaymentAmount || '0');
        if (paymentAmountValue > 0) payload.payment_amount = paymentAmountValue;
        if (!checkoutIsPaid) {
          if (checkoutDueDate) {
            payload.payment_due_date = checkoutDueDate;
          } else {
            const defaultDue = new Date();
            defaultDue.setDate(defaultDue.getDate() + 7);
            payload.payment_due_date = defaultDue.toISOString().split('T')[0];
          }
        }
        return djangoClient.sales.create(payload);
      }));
      toast.success('Paiement enregistré pour le panier');
      setCheckoutOpen(false);
      setCartItems([]);
      setCheckoutCustomer('');
      setCheckoutIsPaid(true);
      setCheckoutPaymentAmount('');
      setCheckoutDueDate('');
      await fetchData();
    } catch (err: any) {
      toast.error(err.message ?? 'Erreur lors du paiement');
    } finally {
      setCheckoutSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingProduct) return;
    setDeleteLoading(true);
    try {
      await djangoClient.products.delete(deletingProduct.id);
      toast.success('Produit supprimé');
      setDeleteDialogOpen(false);
      setProducts(prev => prev.filter(p => p.id !== deletingProduct.id));
    } catch (err: any) {
      toast.success('Produit supprimé');
      setDeleteDialogOpen(false);
      fetchData();

      // toast.error(err.message ?? 'Erreur');
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Produits</h1>
          <p className="text-muted-foreground mt-1">Gestion du catalogue et des stocks</p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={handleImportExcel}
          />
          <Button variant="outline" size="sm" onClick={openImportDialog} disabled={importing}>
            <Upload className="h-4 w-4 mr-2" />Importer
          </Button>

          {/* Import store-picker dialog (admin only) */}
          <Dialog open={importDialogOpen} onOpenChange={open => { setImportDialogOpen(open); if (!open) { setImportMagasinId(''); setImportStoreFilter(''); } }}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Importer des produits</DialogTitle>
                <DialogDescription>Choisissez le magasin destination avant de sélectionner le fichier Excel.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <div className="space-y-2">
                  <Label>Rechercher un magasin</Label>
                  <Input
                    placeholder="Nom du magasin..."
                    value={importStoreFilter}
                    onChange={e => setImportStoreFilter(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Magasin *</Label>
                  <Select value={importMagasinId} onValueChange={setImportMagasinId}>
                    <SelectTrigger>
                      <SelectValue placeholder={storesLoading ? 'Chargement...' : 'Choisir un magasin'} />
                    </SelectTrigger>
                    <SelectContent>
                      {storesLoading ? (
                        <SelectItem value="__loading__" disabled>Chargement...</SelectItem>
                      ) : stores
                          .filter(s => !importStoreFilter || (s.shop_name || '').toLowerCase().includes(importStoreFilter.toLowerCase()))
                          .map(s => (
                            <SelectItem key={s.magasin_id} value={String(s.magasin_id)}>
                              {s.shop_name}
                            </SelectItem>
                          ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setImportDialogOpen(false)}>Annuler</Button>
                <Button onClick={confirmImportStore} disabled={!importMagasinId}>
                  <Upload className="h-4 w-4 mr-2" />Choisir le fichier
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          <Button variant="outline" size="sm" onClick={handleExportExcel}>
            <Download className="h-4 w-4 mr-2" />Exporter
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/scanner">
              <QrCode className="h-4 w-4 mr-2" />Scanner QR
            </Link>
          </Button>
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleOpenTransfer}
              disabled={selectedProductIds.size === 0 || selectedStoreId === 'all'}
            >
              <ArrowLeftRight className="h-4 w-4 mr-2" />
              Transférer{selectedProductIds.size > 0 ? ` (${selectedProductIds.size})` : ''}
            </Button>
          )}
          {canCreate && (
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                {isAdmin && <Button size="sm"><Plus className="h-4 w-4" />Ajouter</Button>}
              </DialogTrigger>
              <DialogContent className="max-w-2xl w-[calc(100vw-2rem)] max-h-[90vh] overflow-y-auto">
                <DialogHeader><DialogTitle>Ajouter un produit</DialogTitle></DialogHeader>
                <ProductForm
                  form={form} setForm={setForm} isAdmin={isAdmin}
                  stores={stores} storesLoading={storesLoading}
                  onSubmit={handleAddProduct} onCancel={() => setDialogOpen(false)}
                  saving={saving} submitLabel="Ajouter"
                />
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>
      {importErrors.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-800 dark:text-red-300">
          <p className="font-semibold">Erreurs d'import :</p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            {importErrors.map((error, idx) => <li key={idx}>{error}</li>)}
          </ul>
        </div>
      )}

      {/* Expiry alert */}
      {expiringProducts.length > 0 && (
        <div className="rounded-lg border border-orange-300 bg-orange-50 dark:bg-orange-950/20 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-orange-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-orange-800 dark:text-orange-300">
                {expiringProducts.filter(p => p.expiryInfo.days < 0).length > 0
                  ? `${expiringProducts.filter(p => p.expiryInfo.days < 0).length} produit(s) périmé(s) — ` : ''}
                {expiringProducts.filter(p => p.expiryInfo.days >= 0).length} produit(s) expirant dans 30 jours
              </p>
              <ul className="mt-2 space-y-1">
                {expiringProducts.slice(0, 5).map(p => (
                  <li key={p.id} className="text-sm text-orange-700 flex items-center gap-2">
                    <span className="font-mono text-xs bg-orange-100 px-1 rounded">{p.reference}</span>
                    <span className="font-medium truncate">{p.name}</span>
                    <span className={`shrink-0 text-xs font-semibold px-1.5 py-0.5 rounded ${p.expiryInfo.cls}`}>
                      {p.expiryInfo.days < 0 ? 'PÉRIMÉ' : `expire le ${fmtDate(p.expiry_date)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col md:flex-row flex-wrap gap-4">
        <Input placeholder="Rechercher par nom, référence ou marque..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="flex-1 min-w-[200px]" />
        {isAdmin ? (
          <Select value={selectedStoreId} onValueChange={setSelectedStoreId}>
            <SelectTrigger className="w-full md:w-52">
              <SelectValue placeholder="Tous les magasins" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tous les magasins</SelectItem>
              {storesLoading ? (
                <SelectItem value="__loading__" disabled>Chargement...</SelectItem>
              ) : (
                stores.map((store) => (
                  <SelectItem key={store.magasin_id} value={String(store.magasin_id)}>
                    {store.shop_name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        ) : (
          user?.shop_name && (
            <div className="flex items-center rounded-md border bg-muted/50 px-3 py-2 text-sm whitespace-nowrap">
              Magasin : <span className="font-medium ml-1">{user.shop_name}</span>
            </div>
          )
        )}
        <Select value={selectedCategory} onValueChange={setSelectedCategory}>
          <SelectTrigger className="w-full md:w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Toutes les catégories</SelectItem>
            {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={selectedStatus} onValueChange={setSelectedStatus}>
          <SelectTrigger className="w-full md:w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous les statuts</SelectItem>
            <SelectItem value="in_stock">En stock</SelectItem>
            <SelectItem value="low">Faible</SelectItem>
            <SelectItem value="out_of_stock">Rupture</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>Catalogue ({filteredProducts.length})</CardTitle>
          {isAdmin && selectedProductIds.size > 0 && (
            <Badge variant="secondary">{selectedProductIds.size} produit(s) sélectionné(s)</Badge>
          )}
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {isAdmin && (
                      <TableHead className="w-10">
                        <Checkbox
                          checked={
                            filteredProducts.length > 0 &&
                            selectedProductIds.size === filteredProducts.length
                          }
                          onCheckedChange={toggleSelectAllProducts}
                          aria-label="Tout sélectionner"
                        />
                      </TableHead>
                    )}
                    <TableHead className="w-14">Image</TableHead>
                    <TableHead>Référence</TableHead>
                    <TableHead>Nom</TableHead>
                    <TableHead>Catégorie</TableHead>
                    <TableHead>Variantes</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Stock</TableHead>
                    <TableHead className="text-right">Prix vente</TableHead>
                    {isAdmin && <TableHead>Magasin</TableHead>}
                    {isAdmin && <TableHead className="text-right">Prix achat</TableHead>}
                    <TableHead>QR Code</TableHead>
                    <TableHead>Péremption</TableHead>
                    <TableHead>Statut</TableHead>
                    {(canEdit || canDelete || isManager) && <TableHead>Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredProducts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={isAdmin ? 14 : 13} className="text-center py-8 text-muted-foreground">Aucun produit trouvé</TableCell>
                    </TableRow>
                  ) : filteredProducts.map(product => {
                    const status = getStatus(product);
                    const expiry = getExpiryInfo(product.expiry_date);
                    const img = imageUrl(product.image1);
                    return (
                      <TableRow key={product.id} className={selectedProductIds.has(product.id) ? 'bg-muted/40' : ''}>
                        {isAdmin && (
                          <TableCell>
                            <Checkbox
                              checked={selectedProductIds.has(product.id)}
                              onCheckedChange={() => toggleProductSelection(product.id)}
                              aria-label={`Sélectionner ${product.name}`}
                            />
                          </TableCell>
                        )}
                        <TableCell>
                          <button
                            type="button"
                            onClick={() => {
                              const firstImage = img || imageUrl(product.image2) || imageUrl(product.image3) || imageUrl(product.qr_code);
                              setPreviewProduct(product);
                              setPreviewImageUrl(firstImage);
                            }}
                            className="group inline-flex w-10 h-10 rounded overflow-hidden bg-muted border shrink-0 items-center justify-center transition hover:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            {img
                              ? <img src={img} alt={product.name} className="w-full h-full object-cover" />
                              : <span className="text-[10px] text-muted-foreground">img</span>
                            }
                          </button>
                        </TableCell>
                        <TableCell className="font-mono text-sm">{product.reference}</TableCell>
                        <TableCell>
                          <p className="font-medium">{product.name}</p>
                          <p className="text-xs text-muted-foreground">{product.brand || ''}</p>
                        </TableCell>
                        <TableCell className="text-sm">{product.category || '-'}</TableCell>
                        <TableCell className="text-sm max-w-[220px]">
                          {product.variants && product.variants.length > 0 ? (
                            <div className="flex items-center gap-2">
                              <div className="flex flex-wrap gap-1 flex-1 min-w-0">
                                {product.variants.slice(0, 2).map((v: any, idx: number) => (
                                  <span
                                    key={idx}
                                    className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-100 dark:bg-slate-800 dark:border-slate-600 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap"
                                  >
                                    <span className="font-semibold text-slate-900 dark:text-white">{v.quantity}</span>
                                    {v.size && <span className="uppercase">{v.size}</span>}
                                    {v.color && <span className="text-muted-foreground">{v.color}</span>}
                                  </span>
                                ))}
                                {product.variants.length > 2 && (
                                  <span className="text-[11px] text-muted-foreground self-center">+{product.variants.length - 2}</span>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={() => setVariantsDialogProduct(product)}
                                className="shrink-0 rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                                title="Voir toutes les variantes"
                              >
                                <Eye className="h-4 w-4" />
                              </button>
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm max-w-[200px]">
                          <p className="truncate text-muted-foreground">{product.description || '—'}</p>
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge variant="outline">{product.initial_quantity ?? 0}</Badge>
                        </TableCell>
                        <TableCell className="text-right text-sm">{Number(product.shell_price || 0).toLocaleString('fr-MG')} Ar</TableCell>
                        {isAdmin && (
                          <TableCell className="text-sm">
                            {product.shop_name || product.magasin?.shop_name || '—'}
                          </TableCell>
                        )}
                        {isAdmin && (
                          <TableCell className="text-right text-sm text-muted-foreground">
                            {product.unit_price != null ? `${Number(product.unit_price).toLocaleString('fr-MG')} Ar` : '—'}
                          </TableCell>
                        )}
                        <TableCell>
                          {product.qr_code ? (
                            <div className="w-10 h-10 rounded overflow-hidden border bg-muted">
                              <img
                                src={imageUrl(product.qr_code) || ''}
                                alt={`${product.name} QR code`}
                                className="w-full h-full object-cover"
                              />
                            </div>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">N/A</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {expiry ? (
                            <div className="flex items-center gap-1">
                              {expiry.icon && <AlertTriangle className="h-3.5 w-3.5 text-red-500" />}
                              <Badge className={expiry.cls}>{expiry.label}</Badge>
                            </div>
                          ) : <span className="text-xs text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell>
                          <Badge className={statusColor(status)}>{statusLabel(status)}</Badge>
                        </TableCell>
                        {(canEdit || canDelete || isManager) && (
                          <TableCell>
                            <div className="flex gap-1">
                              {canEdit && (
                                <Button variant="ghost" size="sm" onClick={() => { setEditingProduct({ ...product }); setEditDialogOpen(true); }}>
                                  <Pencil className="h-4 w-4" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleAddToCart(product)}
                                disabled={(product.initial_quantity ?? 0) <= 0}
                              >
                                <ShoppingCart className="h-4 w-4" />
                              </Button>
                              {/* Managers can only add stock (increase quantity), not edit or delete */}
                              {isManager && (
                                <Button variant="ghost" size="sm" onClick={() => { setAddingProduct(product); setAddAmount(0); setAddStockDialogOpen(true); }}>
                                  <Plus className="h-4 w-4" />
                                </Button>
                              )}
                              {canDelete && (
                                <Button variant="ghost" size="sm" onClick={() => { setDeletingProduct(product); setDeleteDialogOpen(true); }}>
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-2xl w-[calc(100vw-2rem)] max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Modifier le produit</DialogTitle><DialogDescription>Informations du produit</DialogDescription></DialogHeader>
          {editingProduct && (
            <ProductForm
              form={editingProduct} setForm={setEditingProduct} isAdmin={isAdmin}
              onSubmit={handleUpdateProduct} onCancel={() => setEditDialogOpen(false)}
              saving={editSaving} submitLabel="Enregistrer"
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Supprimer le produit</DialogTitle><DialogDescription>Cette action est irréversible.</DialogDescription></DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>Annuler</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteLoading}>
              {deleteLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Supprimer
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Stock Dialog (for managers) */}
      <Dialog open={addStockDialogOpen} onOpenChange={setAddStockDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ajouter du stock</DialogTitle>
            <DialogDescription>Ajoute une quantité positive au stock existant. Cette action ne peut qu'augmenter la quantité.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Produit</Label>
              <div className="font-medium">{addingProduct?.name || ''} — Réf: {addingProduct?.reference || ''}</div>
              <div className="text-sm text-muted-foreground">Stock actuel: {addingProduct?.initial_quantity ?? 0}</div>
            </div>
            <div>
              <Label>Quantité à ajouter</Label>
              <Input type="number" min={1} value={String(addAmount)} onChange={e => setAddAmount(Number(e.target.value || 0))} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAddStockDialogOpen(false)}>Annuler</Button>
              <Button onClick={async () => {
                if (!addingProduct) return;
                const add = Number(addAmount) || 0;
                if (add <= 0) { toast.error('Veuillez spécifier une quantité positive à ajouter.'); return; }
                setAddLoading(true);
                try {
                  const current = Number(addingProduct.initial_quantity || 0);
                  const newQty = current + add;
                  const fd = new FormData();
                  fd.append('initial_quantity', String(newQty));
                  await djangoClient.patchFormData(`/users/products/${addingProduct.id}/`, fd);
                  toast.success('Stock mis à jour');
                  setAddStockDialogOpen(false);
                  setAddingProduct(null);
                  await fetchData();
                } catch (err: any) {
                  toast.error(err?.message || 'Erreur lors de la mise à jour du stock');
                } finally {
                  setAddLoading(false);
                }
              }} disabled={addLoading}>{addLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : 'Ajouter'}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(previewProduct)} onOpenChange={(open) => {
        if (!open) {
          setPreviewProduct(null);
          setPreviewImageUrl(null);
        }
      }}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Prévisualisation des images</DialogTitle>
            <DialogDescription>{previewProduct?.name}</DialogDescription>
          </DialogHeader>
          {previewProduct && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="rounded-xl border bg-card p-4">
                  {previewImageUrl ? (
                    <img
                      src={previewImageUrl}
                      alt={previewProduct.name}
                      className="w-full max-h-96 object-contain rounded-lg"
                    />
                  ) : (
                    <div className="flex h-96 items-center justify-center text-muted-foreground">Aucune image disponible</div>
                  )}
                </div>
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-semibold">Images disponibles</h3>
                    <div className="grid grid-cols-3 gap-3 mt-3">
                      {[
                        { label: 'Principale', url: imageUrl(previewProduct.image1) },
                        { label: 'Secondaire 1', url: imageUrl(previewProduct.image2) },
                        { label: 'Secondaire 2', url: imageUrl(previewProduct.image3) },
                        { label: 'QR Code', url: imageUrl(previewProduct.qr_code) },
                      ].filter(item => item.url).map((item) => (
                        <button
                          key={item.label}
                          type="button"
                          onClick={() => setPreviewImageUrl(item.url)}
                          className="rounded-lg border border-slate-300 overflow-hidden focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <img src={item.url!} alt={item.label} className="h-24 w-full object-cover" />
                          <div className="px-2 py-1 text-center text-xs text-muted-foreground">{item.label}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                    <p><strong>Nom:</strong> {previewProduct.name}</p>
                    <p><strong>Réf:</strong> {previewProduct.reference}</p>
                    <p><strong>Catégorie:</strong> {previewProduct.category}</p>
                    {previewProduct.magasin?.shop_name && <p><strong>Magasin:</strong> {previewProduct.magasin.shop_name}</p>}
                  </div>
                  <div className="flex justify-end">
                    <Button variant="outline" onClick={() => { setPreviewProduct(null); setPreviewImageUrl(null); }}>Fermer</Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {cartItems.length > 0 && (
        <>
          <div className="fixed right-4 bottom-4 z-50 w-80 rounded-3xl border border-slate-200 bg-white/95 p-4 shadow-2xl backdrop-blur-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">Panier</p>
                <p className="text-xs text-muted-foreground">{cartCount} article(s)</p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setCheckoutOpen(true)}>
                <ShoppingCart className="h-4 w-4" /> Payer
              </Button>
            </div>
            <div className="mt-3 space-y-2 max-h-48 overflow-y-auto">
              {cartItems.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{item.name}</p>
                    <p className="text-xs text-muted-foreground">x{item.quantity} · {Number(item.shell_price || 0).toLocaleString('fr-MG')} Ar</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveCartItem(item.id)}
                    className="text-sm font-semibold text-red-600 hover:text-red-700"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-3 text-sm font-semibold">
              <span>Total</span>
              <span>{cartTotal.toLocaleString('fr-MG')} Ar</span>
            </div>
          </div>

          <Dialog open={checkoutOpen} onOpenChange={setCheckoutOpen}>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Paiement du panier</DialogTitle>
                <DialogDescription>Finalisez la vente de {cartCount} produit(s)</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCheckout} className="space-y-4 pt-2">
                <div className="space-y-2">
                  <Label>Nom du client</Label>
                  <Input
                    placeholder="Nom du client"
                    value={checkoutCustomer}
                    onChange={e => setCheckoutCustomer(e.target.value)}
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Button
                    type="button"
                    variant={checkoutIsPaid ? 'secondary' : 'outline'}
                    size="sm"
                    className="w-full"
                    onClick={() => setCheckoutIsPaid(true)}
                  >
                    Payé
                  </Button>
                  <Button
                    type="button"
                    variant={!checkoutIsPaid ? 'secondary' : 'outline'}
                    size="sm"
                    className="w-full"
                    onClick={() => setCheckoutIsPaid(false)}
                  >
                    Pas encore
                  </Button>
                </div>
                {!checkoutIsPaid && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Montant versé (optionnel)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={checkoutPaymentAmount}
                        onChange={e => setCheckoutPaymentAmount(e.target.value)}
                        placeholder="0.00"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Échéance de paiement</Label>
                      <Input
                        type="date"
                        value={checkoutDueDate}
                        onChange={e => setCheckoutDueDate(e.target.value)}
                      />
                    </div>
                  </div>
                )}
                {!checkoutIsPaid && checkoutDueInfo && (
                  <div className={`rounded-xl p-3 text-sm ${checkoutDueInfo.isOverdue ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-yellow-50 text-yellow-700 border border-yellow-200'}`}>
                    {checkoutDueInfo.isOverdue ? (
                      <p>Retard de paiement : {checkoutDueInfo.daysLate} jour(s).</p>
                    ) : (
                      <p>Échéance de paiement dans {checkoutDueInfo.daysUntil} jour(s).</p>
                    )}
                    <p className="text-xs text-muted-foreground">Échéance : {checkoutDueDate}</p>
                  </div>
                )}
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>Total panier</span>
                    <span>{cartTotal.toLocaleString('fr-MG')} Ar</span>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" type="button" onClick={() => setCheckoutOpen(false)}>Annuler</Button>
                  <Button type="submit" disabled={checkoutSubmitting}>
                    {checkoutSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Valider le paiement
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </>
      )}

      {isAdmin && (
        <TransferProductsDialog
          open={transferDialogOpen}
          onOpenChange={setTransferDialogOpen}
          sourceStore={sourceStoreForTransfer}
          stores={stores}
          initialCart={transferInitialCart}
          onSuccess={handleTransferSuccess}
        />
      )}

      {/* Variants Detail Dialog */}
      <Dialog open={Boolean(variantsDialogProduct)} onOpenChange={open => { if (!open) setVariantsDialogProduct(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Variantes — {variantsDialogProduct?.name}</DialogTitle>
            <DialogDescription>
              {variantsDialogProduct?.variants?.length ?? 0} variante(s) · stock total : {variantsDialogProduct?.initial_quantity ?? 0}
            </DialogDescription>
          </DialogHeader>
          {variantsDialogProduct && (
            <VariantsDialogBody variants={variantsDialogProduct.variants ?? []} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ProductVariant {
  size: string;
  color: string;
  quantity: number;
}

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];

function VariantsDialogBody({ variants }: { variants: ProductVariant[] }) {
  const [activeColor, setActiveColor] = useState<string | null>(null);

  const colorGroups = useMemo(() => {
    const groups: Record<string, ProductVariant[]> = {};
    for (const v of variants) {
      const key = v.color?.trim() || 'Sans couleur';
      if (!groups[key]) groups[key] = [];
      groups[key].push(v);
    }
    return groups;
  }, [variants]);

  const colors = Object.keys(colorGroups);
  const displayed = activeColor ? { [activeColor]: colorGroups[activeColor] } : colorGroups;

  const sortedVariants = (vars: ProductVariant[]) =>
    [...vars].sort((a, b) => {
      const ia = SIZE_ORDER.indexOf((a.size ?? '').toUpperCase());
      const ib = SIZE_ORDER.indexOf((b.size ?? '').toUpperCase());
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

  return (
    <div className="space-y-4 mt-1">
      {colors.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveColor(null)}
            className={`rounded-full px-3 py-1 text-sm font-medium transition-colors border ${
              activeColor === null
                ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900'
                : 'border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700'
            }`}
          >
            Tout
          </button>
          {colors.map(color => (
            <button
              key={color}
              type="button"
              onClick={() => setActiveColor(activeColor === color ? null : color)}
              className={`rounded-full px-3 py-1 text-sm font-medium transition-colors border ${
                activeColor === color
                  ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900'
                  : 'border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700'
              }`}
            >
              {color}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
        {Object.entries(displayed).map(([color, vars]) => (
          <div key={color} className="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">{color}</span>
              <span className="text-xs text-muted-foreground">{vars.reduce((s, v) => s + v.quantity, 0)} unités</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {sortedVariants(vars).map((v, i) => (
                <div
                  key={i}
                  className="flex flex-col items-center rounded-lg border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-800 px-3 py-2 min-w-[52px]"
                >
                  <span className="text-[11px] text-muted-foreground uppercase font-medium">{v.size || '—'}</span>
                  <span className="text-xl font-bold text-slate-900 dark:text-white leading-tight">{v.quantity}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ProductFormProps {
  form: any; setForm: (v: any) => void; isAdmin: boolean;
  stores?: any[]; storesLoading?: boolean;
  onSubmit: () => void; onCancel: () => void;
  saving: boolean; submitLabel: string;
}

function ProductForm({ form, setForm, isAdmin, stores = [], storesLoading = false, onSubmit, onCancel, saving, submitLabel }: ProductFormProps) {
  const [storeFilter, setStoreFilter] = useState('');
  const [variantSize, setVariantSize] = useState('');
  const [variantColor, setVariantColor] = useState('');
  const [variantQty, setVariantQty] = useState<number | ''>('');
  const set = (key: string, value: any) => setForm((prev: any) => ({ ...prev, [key]: value }));

  const variants: ProductVariant[] = form.variants ?? [];

  const totalVariantQty = variants.reduce((s: number, v: ProductVariant) => s + (v.quantity || 0), 0);

  const addVariant = () => {
    const qty = Number(variantQty);
    if (qty <= 0 || (!variantSize && !variantColor)) return;
    const updated = [...variants, { size: variantSize.trim(), color: variantColor.trim(), quantity: qty }];
    set('variants', updated);
    set('initial_quantity', String(updated.reduce((s, v) => s + v.quantity, 0)));
    setVariantSize('');
    setVariantColor('');
    setVariantQty('');
  };

  const removeVariant = (idx: number) => {
    const updated = variants.filter((_, i) => i !== idx);
    set('variants', updated);
    set('initial_quantity', String(updated.reduce((s, v) => s + v.quantity, 0)));
  };

  const updateVariantQty = (idx: number, qty: number) => {
    if (qty < 0) return;
    const updated = variants.map((v, i) => i === idx ? { ...v, quantity: qty } : v);
    set('variants', updated);
    set('initial_quantity', String(updated.reduce((s, v) => s + v.quantity, 0)));
  };

  const dataURLtoFile = (dataUrl: string, filename: string) => {
    const arr = dataUrl.split(',');
    const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/png';
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, { type: mime });
  };

  const handleDropImages = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    set('image2', files[0]);
    if (files[1]) set('image3', files[1]);
    toast.success(`${Math.min(files.length, 2)} image(s) ajoutée(s)`);
  };

  const handleGenerateQr = async () => {
    const qrSource = form.reference || form.name;
    if (!qrSource) {
      toast.error('Veuillez renseigner la référence ou le nom du produit pour générer un QR code.');
      return;
    }
    try {
      const dataUrl = await generateSimpleQRCode(qrSource);
      const qrFile = dataURLtoFile(dataUrl, `qr-${qrSource.replace(/\s+/g, '-')}.png`);
      set('qr_code', qrFile);
      toast.success('QR code généré');
    } catch (err: any) {
      console.error(err);
      toast.error('Impossible de générer le QR code.');
    }
  };

  const filteredStores = stores.filter((store) => {
    const label = String(store.shop_name || store.manager?.full_name || '').toLowerCase();
    return storeFilter === '' || label.includes(storeFilter.toLowerCase());
  });

  const previewName = (field: string) => {
    const value = form[field];
    if (!value) return null;
    if (value instanceof File) return value.name;
    return String(value).split('/').pop();
  };

  const fileInputClass =
    'w-full rounded-md border border-input bg-background text-foreground text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-muted/80';

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {isAdmin && (
          <div className="space-y-2 md:col-span-2">
            <Label>Magasin *</Label>
            <Input
              placeholder="Rechercher un magasin..."
              value={storeFilter}
              onChange={e => setStoreFilter(e.target.value)}
            />
            <Select
              value={form.magasin ? String(form.magasin) : ''}
              onValueChange={v => set('magasin', v)}
            >
              <SelectTrigger>
                <SelectValue placeholder={storesLoading ? 'Chargement des magasins...' : 'Choisir un magasin'} />
              </SelectTrigger>
              <SelectContent>
                {storesLoading ? (
                  <SelectItem value="__loading__" disabled>Chargement...</SelectItem>
                ) : filteredStores.length > 0 ? (
                  filteredStores.map(store => (
                    <SelectItem key={store.magasin_id || store.id || store.shop_name} value={String(store.magasin_id || store.id || '')}>
                      {store.shop_name || store.manager?.full_name || 'Magasin inconnu'}
                    </SelectItem>
                  ))
                ) : (
                  <SelectItem value="__none__" disabled>Aucun magasin trouvé</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-2">
          <Label>Référence / SKU *</Label>
          <Input placeholder="Ex: CREM-001" value={form.reference || ''} onChange={e => set('reference', e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Nom du produit *</Label>
          <Input placeholder="Ex: Crème hydratante" value={form.name || ''} onChange={e => set('name', e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Marque</Label>
          <Input placeholder="Ex: L'Oréal" value={form.brand || ''} onChange={e => set('brand', e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Catégorie *</Label>
          <Select value={form.category || ''} onValueChange={v => set('category', v)}>
            <SelectTrigger><SelectValue placeholder="Choisir" /></SelectTrigger>
            <SelectContent>{CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label>Description</Label>
          <Textarea placeholder="Description du produit..." rows={2} value={form.description || ''} onChange={e => set('description', e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Prix Unitaire (Ar) *</Label>
          <Input type="number" step="0.01" placeholder="0.00" value={form.unit_price || ''} onChange={e => set('unit_price', e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Prix de vente (Ar) *</Label>
          <Input type="number" step="0.01" placeholder="0.00" value={form.shell_price || ''} onChange={e => set('shell_price', e.target.value)} />
        </div>

        <div className="space-y-2 md:col-span-2">
          <Label>Seuil d'alerte</Label>
          <Input type="number" min="0" placeholder="5" value={form.alert_threshold ?? ''} onChange={e => set('alert_threshold', e.target.value)} className="max-w-[180px]" />
        </div>
      </div>

      {/* Variant manager */}
      <div className="space-y-3 rounded-lg border border-border bg-muted/20 dark:bg-muted/10 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Variantes (taille × couleur × quantité)</h3>
          {variants.length > 0 && (
            <span className="text-xs text-muted-foreground">Total : {totalVariantQty} unité(s)</span>
          )}
        </div>

        {/* Entry row */}
        <div className="flex flex-wrap gap-2 items-end">
          <div className="space-y-1 min-w-[90px]">
            <Label className="text-xs">Taille</Label>
            <Select value={variantSize || '__none__'} onValueChange={v => setVariantSize(v === '__none__' ? '' : v)}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">—</SelectItem>
                {['XS','S','M','L','XL','2XL','3XL','4XL'].map(t => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 flex-1 min-w-[80px]">
            <Label className="text-xs">Quantité</Label>
            <Input
              type="number"
              min={1}
              placeholder="ex: 3"
              value={variantQty}
              onChange={e => setVariantQty(e.target.value === '' ? '' : Number(e.target.value))}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addVariant(); } }}
            />
          </div>
          <div className="space-y-1 flex-[2] min-w-[120px]">
            <Label className="text-xs">Couleur</Label>
            <Input
              placeholder="ex: Marron, Blanc…"
              value={variantColor}
              onChange={e => setVariantColor(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addVariant(); } }}
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={addVariant}
            disabled={Number(variantQty) <= 0 || (!variantSize && !variantColor)}
            className="shrink-0"
          >
            <Plus className="h-4 w-4 mr-1" />Ajouter
          </Button>
        </div>

        {/* Variant chips */}
        {variants.length > 0 ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {variants.map((v, idx) => (
              <span
                key={idx}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 dark:bg-slate-800 dark:border-slate-600 px-2 py-1 text-xs font-medium text-slate-700 dark:text-slate-200"
              >
                <input
                  type="number"
                  min={0}
                  value={v.quantity}
                  onChange={e => updateVariantQty(idx, Number(e.target.value) || 0)}
                  className="w-10 rounded border border-slate-300 bg-white dark:bg-slate-700 dark:border-slate-500 text-center text-xs font-bold text-slate-900 dark:text-white px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  aria-label="Quantité"
                />
                {v.size && <span className="uppercase">{v.size}</span>}
                {v.color && <span className="text-muted-foreground">{v.color}</span>}
                <button
                  type="button"
                  onClick={() => removeVariant(idx)}
                  className="ml-0.5 text-slate-400 hover:text-red-500 transition-colors"
                  aria-label="Supprimer"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">Aucune variante ajoutée. Vous pouvez aussi laisser vide et utiliser la quantité directe ci-dessous.</p>
        )}

        {/* Fallback direct quantity when no variants */}
        {variants.length === 0 && (
          <div className="space-y-1 max-w-[200px]">
            <Label className="text-xs">Quantité directe (sans variante)</Label>
            <Input type="number" min="0" placeholder="0" value={form.initial_quantity ?? ''} onChange={e => set('initial_quantity', e.target.value)} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2 md:col-span-2">
          <Label className="flex items-center gap-2">
            Date de péremption
            <span className="text-xs font-normal text-muted-foreground">(optionnel)</span>
          </Label>
          <Input
            type="date" value={form.expiry_date || ''}
            onChange={e => set('expiry_date', e.target.value)}
            min={new Date().toISOString().split('T')[0]}
          />
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-muted/20 dark:bg-muted/10 p-4">
        <h3 className="text-sm font-semibold">Images du produit</h3>

        <div className="space-y-2">
          <Label>Image principale</Label>
          <input
            type="file"
            accept="image/*"
            className={fileInputClass}
            onChange={e => set('image1', e.target.files?.[0] ?? null)}
          />
          {previewName('image1') && (
            <p className="text-xs text-muted-foreground truncate">Fichier : {previewName('image1')}</p>
          )}
        </div>

        <div className="space-y-3">
          <Label>Images supplémentaires (max. 2)</Label>
          <div
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDropImages}
            className="min-h-[100px] rounded-lg border border-dashed border-input bg-muted/30 dark:bg-muted/20 p-4 text-sm text-muted-foreground flex flex-col items-center justify-center text-center"
          >
            <Upload className="h-5 w-5 mb-2 opacity-70" />
            Glissez-déposez jusqu&apos;à 2 images ici
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Secondaire 1</Label>
              <input
                type="file"
                accept="image/*"
                className={fileInputClass}
                onChange={e => set('image2', e.target.files?.[0] ?? null)}
              />
              {previewName('image2') && (
                <p className="text-xs text-muted-foreground truncate">Fichier : {previewName('image2')}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Secondaire 2</Label>
              <input
                type="file"
                accept="image/*"
                className={fileInputClass}
                onChange={e => set('image3', e.target.files?.[0] ?? null)}
              />
              {previewName('image3') && (
                <p className="text-xs text-muted-foreground truncate">Fichier : {previewName('image3')}</p>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-2 border-t border-border pt-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <Label>QR Code produit</Label>
            <Button variant="secondary" size="sm" type="button" onClick={handleGenerateQr}>
              Générer QR
            </Button>
          </div>
          <input
            type="file"
            accept="image/*"
            className={fileInputClass}
            onChange={e => set('qr_code', e.target.files?.[0] ?? null)}
          />
          {previewName('qr_code') && (
            <p className="text-xs text-muted-foreground truncate">Fichier : {previewName('qr_code')}</p>
          )}
        </div>
      </div>

      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onCancel}>Annuler</Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}{submitLabel}
        </Button>
      </div>
    </div>
  );
}
