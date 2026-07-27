'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { djangoClient } from '@/lib/django-client';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import {
  Plus,
  ShoppingCart,
  TrendingUp,
  DollarSign,
  Package,
  Search,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Download,
  Trash2,
  Printer,
  X,
} from 'lucide-react';
import * as XLSX from 'xlsx';

import { toast } from 'sonner';
import { useRealtimeRefresh } from '@/lib/hooks/useRealtimeRefresh';

interface Sale {
  id: number;
  product?: number;
  product_name?: string;
  variant?: number;
  variant_label?: string | null;
  seller_name?: string;
  shop_name?: string;
  customer_name?: string;
  quantity: number;
  sale_price: number;
  total_price: number;
  sold_at: string;
  is_paid: boolean;
  payment_amount?: number;
  payment_due_date?: string;
  payment_date?: string;
  ticket_id?: number | null;
  ticket_image?: string | null;
}

interface ProductVariant {
  id: number;
  size: string | null;
  color: string | null;
  quantity: number;
}

interface Product {
  id: number;
  name: string;
  reference?: string;
  magasin?: number;
  sell_price?: number;
  sale_price?: number;
  shell_price?: number;
  initial_quantity: number;
  alert_threshold?: number;
  variants?: ProductVariant[];
}

interface Store {
  magasin_id: number;
  shop_name: string;
}

interface CartItem {
  key: string;
  product: Product;
  hasVariants: boolean;
  variantLines?: { variantId: number; label: string; quantity: number }[];
  quantity?: number;
  salePrice: number;
}

interface TicketLine {
  name: string;
  variantLabel?: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

interface TicketData {
  ticketNumber: string;
  date: string;
  storeName?: string;
  sellerName?: string;
  customerName?: string;
  items: TicketLine[];
  total: number;
  isPaid: boolean;
  paymentAmount?: number;
  paymentDueDate?: string;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('fr-MG', {
    minimumFractionDigits: 0,
  }).format(Math.round(n));

export default function SalesPage() {
  const { user, isAdmin, isManager } = useCurrentUser();

  const [sales, setSales] = useState<Sale[]>([]);
  const [saleProducts, setSaleProducts] = useState<Product[]>([]);
  const [stores, setStores] = useState<Store[]>([]);

  const [loading, setLoading] = useState(true);
  const [loadingSaleProducts, setLoadingSaleProducts] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [saleStartDate, setSaleStartDate] = useState('');
  const [saleEndDate, setSaleEndDate] = useState('');
  const [dueStartDate, setDueStartDate] = useState('');
  const [dueEndDate, setDueEndDate] = useState('');

  // Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Delete
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingSale, setDeletingSale] = useState<Sale | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [selectedStoreId, setSelectedStoreId] = useState<number | ''>('');
  const [storeSearch, setStoreSearch] = useState('');

  // Form
  const [selectedProduct, setSelectedProduct] =
    useState<Product | null>(null);

  const [productSearch, setProductSearch] = useState('');
  const [showProductDropdown, setShowProductDropdown] =
    useState(false);

  const [quantity, setQuantity] = useState('1');
  const [salePrice, setSalePrice] = useState('');

  const [customerName, setCustomerName] = useState('');

  const [isPaid, setIsPaid] = useState(true);

  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentDueDate, setPaymentDueDate] = useState('');

  // Quantité à vendre par variant (id du variant -> quantité saisie)
  const [variantQuantities, setVariantQuantities] = useState<Record<number, string>>({});

  // Panier (plusieurs produits/variantes dans une seule vente)
  const [cart, setCart] = useState<CartItem[]>([]);

  // Ticket
  const [ticketDialogOpen, setTicketDialogOpen] = useState(false);
  const [ticketData, setTicketData] = useState<TicketData | null>(null);

  const activeStoreId = isAdmin
    ? selectedStoreId
    : (user?.magasin_id ?? user?.store_id ?? '');

  const productVariants = selectedProduct?.variants ?? [];
  const hasVariants = productVariants.length > 0;

  const sellableVariants = useMemo(
    () => productVariants.filter(v => v.quantity > 0),
    [productVariants]
  );

  const handleVariantQtyChange = (variantId: number, rawValue: string, max: number) => {
    if (rawValue === '') {
      setVariantQuantities(prev => ({ ...prev, [variantId]: '' }));
      return;
    }
    const parsed = parseInt(rawValue, 10);
    const clamped = Number.isNaN(parsed) ? 0 : Math.min(Math.max(0, parsed), max);
    setVariantQuantities(prev => ({ ...prev, [variantId]: String(clamped) }));
  };

  const totalVariantQty = useMemo(() => {
    return Object.values(variantQuantities).reduce(
      (sum, val) => sum + (parseInt(val, 10) || 0),
      0
    );
  }, [variantQuantities]);

  const cartItemAmount = (item: CartItem) => {
    const qty = item.hasVariants
      ? (item.variantLines ?? []).reduce((sum, v) => sum + v.quantity, 0)
      : item.quantity ?? 0;
    return qty * item.salePrice;
  };

  const cartTotal = useMemo(
    () => cart.reduce((sum, item) => sum + cartItemAmount(item), 0),
    [cart]
  );

  // Construit un item de panier à partir de la sélection courante du formulaire.
  // Retourne null (et affiche une erreur si `showErrors`) si la sélection est invalide.
  const buildCartItemFromSelection = (showErrors: boolean): CartItem | null => {
    if (!selectedProduct) {
      if (showErrors) toast.error('Veuillez sélectionner un produit');
      return null;
    }

    const price = parseFloat(salePrice);
    if (isNaN(price) || price <= 0) {
      if (showErrors) toast.error('Prix invalide');
      return null;
    }

    if (hasVariants) {
      const variantLines = sellableVariants
        .map((v) => ({
          variantId: v.id,
          label:
            [v.size?.toUpperCase(), v.color].filter(Boolean).join(' / ') ||
            `Variante #${v.id}`,
          quantity: parseInt(variantQuantities[v.id] ?? '', 10) || 0,
        }))
        .filter((v) => v.quantity > 0);

      if (variantLines.length === 0) {
        if (showErrors) {
          toast.error('Veuillez indiquer une quantité pour au moins une variante');
        }
        return null;
      }

      return {
        key: `${selectedProduct.id}-${Date.now()}-${Math.random()}`,
        product: selectedProduct,
        hasVariants: true,
        variantLines,
        salePrice: price,
      };
    }

    const qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty <= 0) {
      if (showErrors) toast.error('Quantité invalide');
      return null;
    }
    if (qty > currentStock) {
      if (showErrors) toast.error(`Stock insuffisant. Disponible : ${currentStock}`);
      return null;
    }

    return {
      key: `${selectedProduct.id}-${Date.now()}-${Math.random()}`,
      product: selectedProduct,
      hasVariants: false,
      quantity: qty,
      salePrice: price,
    };
  };

  const clearProductSelection = () => {
    setSelectedProduct(null);
    setProductSearch('');
    setSalePrice('');
    setQuantity('1');
    setVariantQuantities({});
    setShowProductDropdown(false);
  };

  const handleAddToCart = () => {
    const item = buildCartItemFromSelection(true);
    if (!item) return;

    setCart((prev) => [...prev, item]);
    clearProductSelection();
    toast.success('Produit ajouté au panier');
  };

  const handleRemoveCartItem = (key: string) => {
    setCart((prev) => prev.filter((item) => item.key !== key));
  };

  const fetchStores = useCallback(async () => {
    try {
      const data = await djangoClient.get<Store[]>('/users/magasins/users/');
      setStores(Array.isArray(data) ? data : []);
    } catch (error: any) {
      toast.error(error?.message || 'Erreur lors du chargement des magasins');
    }
  }, []);

  const fetchSaleProducts = useCallback(async (magasinId: number) => {
    setLoadingSaleProducts(true);
    try {
      const productsData = await djangoClient.products.list({ magasin_id: magasinId });
      const storeProducts = (Array.isArray(productsData) ? productsData : []).filter(
        (p) => Number(p.magasin) === Number(magasinId)
      );
      setSaleProducts(storeProducts);
    } catch (error: any) {
      toast.error(error?.message || 'Erreur lors du chargement des produits');
      setSaleProducts([]);
    } finally {
      setLoadingSaleProducts(false);
    }
  }, []);

  // Fetch
  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);

    try {
      const salesData = await djangoClient.sales.list();
      setSales(Array.isArray(salesData) ? salesData : []);
    } catch (error: any) {
      if (!silent) {
        toast.error(
          error?.message || 'Erreur lors du chargement des données'
        );
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useRealtimeRefresh(['sale', 'product'], () => fetchData(true));

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!dialogOpen) return;
    if (isAdmin) {
      fetchStores();
      return;
    }
    const magasinId = user?.magasin_id ?? user?.store_id;
    if (magasinId) {
      fetchSaleProducts(magasinId);
    }
  }, [dialogOpen, isAdmin, user?.magasin_id, user?.store_id, fetchStores, fetchSaleProducts]);

  useEffect(() => {
    if (!dialogOpen || !isAdmin || !selectedStoreId) return;
    fetchSaleProducts(selectedStoreId as number);
  }, [dialogOpen, isAdmin, selectedStoreId, fetchSaleProducts]);

  // Filters
  const filteredSales = useMemo(() => {
    const term = searchTerm.toLowerCase();

    return sales.filter((sale) => {
      const soldDateStr = sale.sold_at ? sale.sold_at.split('T')[0] : '';
      const dueDateStr = sale.payment_due_date ? sale.payment_due_date.split('T')[0] : '';

      const matchesTerm =
        !term ||
        sale.product_name?.toLowerCase().includes(term) ||
        sale.seller_name?.toLowerCase().includes(term) ||
        sale.customer_name?.toLowerCase().includes(term);

      const matchesSaleStart = !saleStartDate || soldDateStr >= saleStartDate;
      const matchesSaleEnd = !saleEndDate || soldDateStr <= saleEndDate;
      const matchesDueStart = !dueStartDate || (dueDateStr && dueDateStr >= dueStartDate);
      const matchesDueEnd = !dueEndDate || (dueDateStr && dueDateStr <= dueEndDate);

      return matchesTerm && matchesSaleStart && matchesSaleEnd && matchesDueStart && matchesDueEnd;
    });
  }, [sales, searchTerm, saleStartDate, saleEndDate, dueStartDate, dueEndDate]);

  const filteredStores = useMemo(() => {
    const term = storeSearch.toLowerCase();
    return stores.filter(
      (store) =>
        !term || store.shop_name?.toLowerCase().includes(term)
    );
  }, [stores, storeSearch]);

  const filteredProducts = useMemo(() => {
    const term = productSearch.toLowerCase();

    return saleProducts
      .filter((product) => {
        if (activeStoreId && Number(product.magasin) !== Number(activeStoreId)) {
          return false;
        }
        return (
          !term ||
          product.name?.toLowerCase().includes(term) ||
          product.reference?.toLowerCase().includes(term)
        );
      })
      .filter((product) => product.initial_quantity > 0);
  }, [saleProducts, productSearch, activeStoreId]);

  // Stats
  const todaySales = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];

    return sales.filter((sale) =>
      sale.sold_at?.startsWith(today)
    );
  }, [sales]);

  const totalRevenue = useMemo(() => {
    return sales.reduce(
      (sum, sale) => sum + Number(sale.total_price || 0),
      0
    );
  }, [sales]);

  const todayRevenue = useMemo(() => {
    return todaySales.reduce(
      (sum, sale) => sum + Number(sale.total_price || 0),
      0
    );
  }, [todaySales]);

  const unpaidSales = useMemo(() => {
    return sales.filter((sale) => !sale.is_paid);
  }, [sales]);

  const unpaidSalesCount = unpaidSales.length;

  const unpaidSalesAmount = useMemo(() => {
    return unpaidSales.reduce((sum, sale) => {
      const total = Number(sale.total_price || 0);
      const paid = Number(sale.payment_amount || 0);

      return sum + Math.max(0, total - paid);
    }, 0);
  }, [unpaidSales]);

  // Product select
  const handleProductSelect = (product: Product) => {
    setSelectedProduct(product);
    setProductSearch(product.name);
    setVariantQuantities({});
    const productPrice = product.sell_price || product.sale_price || product.shell_price || 0;
    setSalePrice(String(productPrice));
    setShowProductDropdown(false);
  };

  const handleStoreChange = (value: string) => {
    const storeId = value ? Number(value) : '';
    setSelectedStoreId(storeId);
    setSelectedProduct(null);
    setProductSearch('');
    setSalePrice('');
    setVariantQuantities({});
    setShowProductDropdown(false);
    setSaleProducts([]);
  };

  // Reset form
  const resetForm = () => {
    setSelectedProduct(null);
    setSelectedStoreId('');
    setStoreSearch('');
    setSaleProducts([]);
    setVariantQuantities({});
    setProductSearch('');
    setQuantity('1');
    setSalePrice('');
    setCustomerName('');
    setIsPaid(true);
    setPaymentAmount('');
    setPaymentDueDate('');
    setShowProductDropdown(false);
    setCart([]);
  };

  // Due info
  const paymentDueInfo = useMemo(() => {
    if (isPaid || !paymentDueDate) {
      return null;
    }

    const dueDate = new Date(paymentDueDate);
    const today = new Date();

    const diffDays = Math.ceil(
      (today.getTime() - dueDate.getTime()) / 86400000
    );

    return {
      dueDate,
      daysLate: diffDays,
      isOverdue: diffDays >= 0,
      daysUntil: Math.max(
        0,
        Math.ceil(
          (dueDate.getTime() - today.getTime()) / 86400000
        )
      ),
    };
  }, [isPaid, paymentDueDate]);

  // Create sale
  const handleCreateSale = async (
    e: React.FormEvent<HTMLFormElement>
  ) => {
    e.preventDefault();

    if (isAdmin && !selectedStoreId) {
      toast.error('Veuillez sélectionner un magasin');
      return;
    }

    // Inclut la sélection courante du formulaire (si valide) en plus du panier,
    // pour ne pas obliger l'utilisateur à cliquer sur "Ajouter au panier" pour une vente simple.
    const draftItem = buildCartItemFromSelection(cart.length === 0);
    const finalItems = draftItem ? [...cart, draftItem] : cart;

    if (finalItems.length === 0) {
      return;
    }

    const paymentAmountValue = parseFloat(paymentAmount || '0');
    const resolvedPaymentDueDate = (() => {
      if (isPaid) return undefined;
      if (paymentDueDate) return paymentDueDate;
      const defaultDate = new Date();
      defaultDate.setDate(defaultDate.getDate() + 7);
      return defaultDate.toISOString().split('T')[0];
    })();

    const grandTotal = finalItems.reduce((sum, item) => sum + cartItemAmount(item), 0);

    setSubmitting(true);

    try {
      const ticketLines: TicketLine[] = [];
      const createdSaleIds: number[] = [];
      let remainingPayment = paymentAmountValue;

      for (let idx = 0; idx < finalItems.length; idx++) {
        const item = finalItems[idx];
        const itemAmount = cartItemAmount(item);
        const isLast = idx === finalItems.length - 1;

        let linePayment = 0;
        if (!isPaid && paymentAmountValue > 0) {
          linePayment = isLast
            ? remainingPayment
            : Math.round((paymentAmountValue * itemAmount / grandTotal) * 100) / 100;
          remainingPayment -= linePayment;
        }

        if (item.hasVariants) {
          const payload: any = {
            product_id: item.product.id,
            sale_price: item.salePrice,
            customer_name: customerName,
            is_paid: isPaid,
            items: item.variantLines!.map((v) => ({
              variant_id: v.variantId,
              quantity: v.quantity,
            })),
          };

          if (linePayment > 0) payload.payment_amount = linePayment;
          if (resolvedPaymentDueDate) payload.payment_due_date = resolvedPaymentDueDate;

          const bulkRes = await djangoClient.sales.createBulk(payload);
          for (const s of bulkRes?.sales ?? []) {
            if (s?.id) createdSaleIds.push(s.id);
          }

          for (const v of item.variantLines!) {
            ticketLines.push({
              name: item.product.name,
              variantLabel: v.label,
              quantity: v.quantity,
              unitPrice: item.salePrice,
              total: v.quantity * item.salePrice,
            });
          }
        } else {
          const payload: any = {
            product: item.product.id,
            quantity: item.quantity,
            sale_price: item.salePrice,
            customer_name: customerName,
            is_paid: isPaid,
          };

          if (linePayment > 0) payload.payment_amount = linePayment;
          if (resolvedPaymentDueDate) payload.payment_due_date = resolvedPaymentDueDate;

          const createRes = await djangoClient.sales.create(payload);
          if (createRes?.id) createdSaleIds.push(createRes.id);

          ticketLines.push({
            name: item.product.name,
            quantity: item.quantity!,
            unitPrice: item.salePrice,
            total: item.quantity! * item.salePrice,
          });
        }
      }

      toast.success('Vente enregistrée avec succès');

      const storeName = isAdmin
        ? filteredStores.find((s) => s.magasin_id === selectedStoreId)?.shop_name
        : user?.shop_name;

      const newTicket: TicketData = {
        ticketNumber: `V-${Date.now().toString(36).toUpperCase()}`,
        date: new Date().toISOString(),
        storeName,
        sellerName: user?.full_name,
        customerName: customerName || undefined,
        items: ticketLines,
        total: grandTotal,
        isPaid,
        paymentAmount: isPaid ? grandTotal : paymentAmountValue || 0,
        paymentDueDate: !isPaid ? resolvedPaymentDueDate : undefined,
      };

      setTicketData(newTicket);

      setDialogOpen(false);
      resetForm();
      setTicketDialogOpen(true);

      await saveTicketRecord(newTicket, createdSaleIds);
      await fetchData();
    } catch (error: any) {
      toast.error(
        error?.message ||
          'Erreur lors de l’enregistrement de la vente'
      );
    } finally {
      setSubmitting(false);
    }
  };

  // Delete sale
  const handleDeleteSale = async () => {
    if (!deletingSale) return;

    setDeleteLoading(true);

    try {
      await djangoClient.sales.delete(deletingSale.id);

      toast.success('Vente supprimée');

      setDeleteDialogOpen(false);
      setDeletingSale(null);

      setSales((prev) => prev.filter((s) => s.id !== deletingSale.id));
    } catch (error: any) {
      toast.error(error?.message || 'Erreur lors de la suppression de la vente');
    } finally {
      setDeleteLoading(false);
    }
  };

  // Date
  const formatDate = (date: string) => {
    if (!date) return '-';

    return new Date(date).toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleExportExcel = () => {
    if (filteredSales.length === 0) {
      toast.error('Aucune vente à exporter pour les filtres sélectionnés');
      return;
    }
    const rows = filteredSales.map((sale) => ({
      'Date vente': formatDate(sale.sold_at),
      Client: sale.customer_name || '',
      Produit: sale.product_name || `Produit #${sale.product}`,
      Quantité: sale.quantity,
      'Prix unitaire (Ar)': sale.sale_price,
      'Total (Ar)': sale.total_price,
      Paiement: sale.is_paid ? 'Payé' : 'Non payé',
      'Montant versé (Ar)': sale.payment_amount ?? '',
      'Date échéance': sale.payment_due_date ? formatDueDate(sale.payment_due_date) : '',
      Vendeur: sale.seller_name || '',
      Magasin: sale.shop_name || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ventes');
    XLSX.writeFile(wb, `ventes_${new Date().toISOString().split('T')[0]}.xlsx`);
    toast.success(`${filteredSales.length} vente(s) exportée(s)`);
  };

  const formatDueDate = (dateStr?: string) => {
    if (!dateStr) return '—';
    const parts = dateStr.split('T')[0].split('-');
    if (parts.length === 3) {
      const [year, month, day] = parts;
      return `${day}/${month}/${year}`;
    }
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  };

  const renderPaymentDueDate = (sale: Sale) => {
    if (sale.is_paid) return <span className="text-muted-foreground">—</span>;
    if (!sale.payment_due_date) return <span className="text-muted-foreground">—</span>;

    const formatted = formatDueDate(sale.payment_due_date);
    
    // Check if overdue
    const dueDate = new Date(sale.payment_due_date);
    dueDate.setHours(23, 59, 59, 999);
    const today = new Date();
    
    const isOverdue = today > dueDate;
    
    if (isOverdue) {
      const diffTime = Math.abs(today.getTime() - dueDate.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      return (
        <div className="flex flex-col">
          <span className="font-semibold text-red-600">{formatted}</span>
          <span className="text-[10px] text-red-500 font-medium">Retard de {diffDays} j.</span>
        </div>
      );
    }
    
    return <span className="font-medium text-amber-600">{formatted}</span>;
  };

  const currentStock = selectedProduct?.initial_quantity ?? 0;

  const hasValidDraft = Boolean(
    selectedProduct &&
      Number(salePrice) > 0 &&
      (hasVariants
        ? totalVariantQty > 0
        : (parseInt(quantity, 10) || 0) > 0 && (parseInt(quantity, 10) || 0) <= currentStock)
  );

  const draftAmount = hasValidDraft
    ? (hasVariants ? totalVariantQty : parseInt(quantity, 10) || 0) * Number(salePrice || 0)
    : 0;

  // Construit un ticket à partir d'une vente déjà enregistrée (pour ré-impression depuis le tableau)
  const buildTicketFromSale = (sale: Sale): TicketData => ({
    ticketNumber: `V-${sale.id}`,
    date: sale.sold_at,
    storeName: sale.shop_name,
    sellerName: sale.seller_name,
    customerName: sale.customer_name || undefined,
    items: [
      {
        name: sale.product_name || `Produit #${sale.product}`,
        variantLabel: sale.variant_label || undefined,
        quantity: sale.quantity,
        unitPrice: Number(sale.sale_price || 0),
        total: Number(sale.total_price || 0),
      },
    ],
    total: Number(sale.total_price || 0),
    isPaid: sale.is_paid,
    paymentAmount: sale.payment_amount,
    paymentDueDate: sale.payment_due_date,
  });

  const escapeHtml = (value: string) =>
    value.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c] as string));

  const buildTicketHtml = (ticket: TicketData) => {
    const rows = ticket.items
      .map(
        (line) => `
          <tr>
            <td>
              ${escapeHtml(line.name)}
              ${line.variantLabel ? `<div class="variant">${escapeHtml(line.variantLabel)}</div>` : ''}
            </td>
            <td class="right">${line.quantity}</td>
            <td class="right">${fmt(line.unitPrice)}</td>
            <td class="right">${fmt(line.total)}</td>
          </tr>`
      )
      .join('');

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Ticket ${escapeHtml(ticket.ticketNumber)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: 'Courier New', monospace;
    width: 300px;
    margin: 0 auto;
    padding: 12px;
    color: #111;
  }
  .center { text-align: center; }
  .store { font-size: 16px; font-weight: bold; }
  hr { border: none; border-top: 1px dashed #999; margin: 8px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; border-bottom: 1px solid #333; padding: 0 0 4px; font-size: 11px; }
  th.right, td.right { text-align: right; }
  th:not(:first-child), td:not(:first-child) { padding-left: 10px; }
  td { padding-top: 4px; padding-bottom: 4px; vertical-align: top; white-space: nowrap; }
  td:first-child { white-space: normal; }
  .right { text-align: right; }
  .variant { font-size: 10px; color: #555; }
  .meta { font-size: 11px; margin: 2px 0; }
  .total-row td { border-top: 1px solid #333; font-weight: bold; padding-top: 6px; }
  .footer { margin-top: 12px; font-size: 11px; }
  @media print {
    body { width: auto; }
  }
</style>
</head>
<body>
  <div class="center store">${escapeHtml(ticket.storeName || 'Boutique')}</div>
  <div class="center meta">Ticket n° ${escapeHtml(ticket.ticketNumber)}</div>
  <div class="center meta">${new Date(ticket.date).toLocaleString('fr-FR')}</div>
  <hr />
  ${ticket.sellerName ? `<div class="meta">Vendeur : ${escapeHtml(ticket.sellerName)}</div>` : ''}
  <div class="meta">Client : ${escapeHtml(ticket.customerName || 'Client de passage')}</div>
  <hr />
  <table>
    <thead>
      <tr><th>Article</th><th class="right">Qté</th><th class="right">P.U.</th><th class="right">Total</th></tr>
    </thead>
    <tbody>
      ${rows}
      <tr class="total-row">
        <td colspan="3">TOTAL</td>
        <td class="right">${fmt(ticket.total)} Ar</td>
      </tr>
    </tbody>
  </table>
  <hr />
  <div class="meta">Paiement : ${ticket.isPaid ? 'Payé' : 'Non payé'}</div>
  ${
    !ticket.isPaid
      ? `<div class="meta">Versé : ${fmt(ticket.paymentAmount || 0)} Ar</div>
         <div class="meta">Échéance : ${ticket.paymentDueDate ? formatDueDate(ticket.paymentDueDate) : '—'}</div>`
      : ''
  }
  <div class="center footer">Merci de votre achat !</div>
</body>
</html>`;
  };

  const printTicket = (ticket: TicketData) => {
    const printWindow = window.open('', '_blank', 'width=380,height=640');
    if (!printWindow) {
      toast.error("Veuillez autoriser les pop-ups pour imprimer le ticket");
      return;
    }
    printWindow.document.write(buildTicketHtml(ticket));
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 300);
  };

  const printImageUrl = (url: string) => {
    // On ouvre une page vide same-origin et on y insère l'image en <img> : naviguer
    // directement window.open() vers l'URL de l'image (autre origine : API vs frontend)
    // empêche ensuite d'appeler .print() sur la fenêtre (erreur de sécurité navigateur).
    const printWindow = window.open('', '_blank', 'width=380,height=640');
    if (!printWindow) {
      toast.error("Veuillez autoriser les pop-ups pour imprimer le ticket");
      return;
    }
    printWindow.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Ticket</title>
<style>
  body { margin: 0; display: flex; justify-content: center; background: #fff; }
  img { max-width: 100%; height: auto; }
</style>
</head>
<body>
  <img src="${escapeHtml(url)}" onload="window.focus(); window.print();" />
</body>
</html>`);
    printWindow.document.close();
  };

  const handlePrintSaleTicket = (sale: Sale) => {
    if (sale.ticket_image) {
      printImageUrl(sale.ticket_image);
      return;
    }
    printTicket(buildTicketFromSale(sale));
  };

  // Dessine le ticket sur un canvas pour produire une image PNG à archiver en base
  const renderTicketToBlob = (ticket: TicketData): Promise<Blob | null> => {
    const width = 380;
    const lineHeight = 20;
    const colQty = width - 16 - 140;
    const colUnit = width - 16 - 70;
    const colTotal = width - 16;

    const itemLines = ticket.items.reduce((sum, l) => sum + (l.variantLabel ? 2 : 1), 0);
    const height = 150 + 30 + itemLines * lineHeight + 60 + (ticket.isPaid ? 60 : 100);

    const canvas = document.createElement('canvas');
    const scale = 2;
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve(null);

    ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#111111';

    const dashedLine = (yPos: number) => {
      ctx.save();
      ctx.strokeStyle = '#999999';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(16, yPos);
      ctx.lineTo(width - 16, yPos);
      ctx.stroke();
      ctx.restore();
    };

    let y = 24;
    ctx.textAlign = 'center';
    ctx.font = 'bold 16px "Courier New", monospace';
    ctx.fillText(ticket.storeName || 'Boutique', width / 2, y);

    y += 18;
    ctx.font = '11px "Courier New", monospace';
    ctx.fillText(`Ticket n° ${ticket.ticketNumber}`, width / 2, y);

    y += 14;
    ctx.fillText(new Date(ticket.date).toLocaleString('fr-FR'), width / 2, y);

    y += 10;
    dashedLine(y);
    y += 16;

    ctx.textAlign = 'left';
    if (ticket.sellerName) {
      ctx.fillText(`Vendeur : ${ticket.sellerName}`, 16, y);
      y += 14;
    }
    ctx.fillText(`Client : ${ticket.customerName || 'Client de passage'}`, 16, y);
    y += 10;
    dashedLine(y);
    y += 20;

    ctx.font = 'bold 11px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('Article', 16, y);
    ctx.textAlign = 'right';
    ctx.fillText('Qté', colQty, y);
    ctx.fillText('P.U.', colUnit, y);
    ctx.fillText('Total', colTotal, y);
    y += 6;
    dashedLine(y);
    y += 16;

    ctx.font = '12px "Courier New", monospace';
    for (const line of ticket.items) {
      ctx.fillStyle = '#111111';
      ctx.textAlign = 'left';
      ctx.fillText(line.name, 16, y);
      ctx.textAlign = 'right';
      ctx.fillText(String(line.quantity), colQty, y);
      ctx.fillText(fmt(line.unitPrice), colUnit, y);
      ctx.fillText(fmt(line.total), colTotal, y);
      y += lineHeight;

      if (line.variantLabel) {
        ctx.textAlign = 'left';
        ctx.font = '10px "Courier New", monospace';
        ctx.fillStyle = '#555555';
        ctx.fillText(line.variantLabel, 16, y);
        ctx.font = '12px "Courier New", monospace';
        y += lineHeight;
      }
    }

    dashedLine(y);
    y += 18;
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 13px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('TOTAL', 16, y);
    ctx.textAlign = 'right';
    ctx.fillText(`${fmt(ticket.total)} Ar`, colTotal, y);

    y += 10;
    dashedLine(y);
    y += 20;

    ctx.font = '11px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`Paiement : ${ticket.isPaid ? 'Payé' : 'Non payé'}`, 16, y);
    y += 14;

    if (!ticket.isPaid) {
      ctx.fillText(`Versé : ${fmt(ticket.paymentAmount || 0)} Ar`, 16, y);
      y += 14;
      ctx.fillText(
        `Échéance : ${ticket.paymentDueDate ? formatDueDate(ticket.paymentDueDate) : '—'}`,
        16,
        y
      );
      y += 14;
    }

    y += 10;
    ctx.textAlign = 'center';
    ctx.fillText('Merci de votre achat !', width / 2, y);

    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    });
  };

  // Génère l'image du ticket et l'archive côté serveur, liée aux ventes qui viennent d'être créées
  const saveTicketRecord = async (ticket: TicketData, saleIds: number[]) => {
    try {
      const blob = await renderTicketToBlob(ticket);
      if (!blob) return;

      const fd = new FormData();
      fd.append('ticket_number', ticket.ticketNumber);
      fd.append('customer_name', ticket.customerName || '');
      fd.append('total_amount', String(ticket.total));
      fd.append('is_paid', String(ticket.isPaid));
      if (ticket.paymentAmount) fd.append('payment_amount', String(ticket.paymentAmount));
      if (ticket.paymentDueDate) fd.append('payment_due_date', ticket.paymentDueDate);
      saleIds.forEach((id) => fd.append('sale_ids', String(id)));
      fd.append('image', blob, `${ticket.ticketNumber}.png`);

      await djangoClient.tickets.create(fd);
    } catch (error) {
      console.error('Erreur lors de l’archivage du ticket', error);
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* HEADER */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight">
            <ShoppingCart className="h-8 w-8 text-blue-600" />
            Ventes
          </h1>

          
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchData()}
            disabled={loading}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${
                loading ? 'animate-spin' : ''
              }`}
            />
            Actualiser
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleExportExcel}
            disabled={loading || filteredSales.length === 0}
          >
            <Download className="mr-2 h-4 w-4" />
            Exporter XLSX
          </Button>

          <Dialog
            open={dialogOpen}
            onOpenChange={(open) => {
              setDialogOpen(open);

              if (!open) {
                resetForm();
              }
            }}
          >
            <DialogTrigger asChild>
              <Button>
                <Plus className=" h-4 w-4" />
                Vendre
              </Button>
            </DialogTrigger>

            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  Vendre un produit
                </DialogTitle>

                <DialogDescription>
                  Ajouter une nouvelle vente
                </DialogDescription>
              </DialogHeader>

              <form
                onSubmit={handleCreateSale}
                className="space-y-4"
              >
                {isAdmin && (
                  <div className="space-y-2">
                    <Label>Magasin</Label>
                    <Input
                      placeholder="Rechercher un magasin..."
                      value={storeSearch}
                      onChange={(e) => setStoreSearch(e.target.value)}
                    />
                    <Select
                      value={selectedStoreId ? String(selectedStoreId) : ''}
                      onValueChange={handleStoreChange}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Choisir un magasin" />
                      </SelectTrigger>
                      <SelectContent>
                        {filteredStores.length > 0 ? (
                          filteredStores.map((store) => (
                            <SelectItem
                              key={store.magasin_id}
                              value={String(store.magasin_id)}
                            >
                              {store.shop_name}
                            </SelectItem>
                          ))
                        ) : (
                          <SelectItem value="__none__" disabled>
                            Aucun magasin trouvé
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {!isAdmin && user?.shop_name && (
                  <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
                    Magasin : <strong>{user.shop_name}</strong>
                  </div>
                )}

                {/* PRODUCT */}
                <div className="space-y-2">
                  <Label>Produit</Label>

                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />

                    <Input
                      className="pl-9"
                      placeholder={
                        isAdmin && !selectedStoreId
                          ? 'Sélectionnez d\'abord un magasin...'
                          : loadingSaleProducts
                          ? 'Chargement des produits...'
                          : 'Rechercher un produit...'
                      }
                      value={productSearch}
                      disabled={
                        (isAdmin && !selectedStoreId) ||
                        loadingSaleProducts ||
                        (!isAdmin && !activeStoreId)
                      }
                      onChange={(e) => {
                        setProductSearch(e.target.value);

                        setSelectedProduct(null);

                        setSalePrice('');

                        setShowProductDropdown(true);
                      }}
                      onFocus={() =>
                        setShowProductDropdown(true)
                      }
                      onBlur={() => {
                        setTimeout(() => {
                          setShowProductDropdown(false);
                        }, 150);
                      }}
                    />

                    {showProductDropdown &&
                      !loadingSaleProducts &&
                      activeStoreId &&
                      filteredProducts.length > 0 && (
                        <div className="absolute z-50 mt-1 max-h-52 w-full overflow-y-auto rounded-md border bg-background shadow-lg">
                          {filteredProducts.map((product) => (
                            <button
                              key={product.id}
                              type="button"
                              className="flex w-full items-start justify-between gap-2 border-b px-3 py-2 text-left hover:bg-muted"
                              onMouseDown={(e) =>
                                e.preventDefault()
                              }
                              onClick={() =>
                                handleProductSelect(product)
                              }
                            >
                              <div>
                                <p className="text-sm font-medium">
                                  {product.name}
                                </p>

                                <p className="font-mono text-xs text-muted-foreground">
                                  {product.reference}
                                </p>
                              </div>

                              <div className="text-right">
                                <p className="text-sm font-semibold">
                                  {fmt(
                                    Number(
                                      product.sell_price ||
                                        product.sale_price ||
                                        product.shell_price ||
                                        0
                                    )
                                  )}{' '}
                                  Ar
                                </p>

                                <Badge
                                  variant={
                                    product.initial_quantity > 5
                                      ? 'default'
                                      : 'destructive'
                                  }
                                  className="text-[10px]"
                                >
                                  <Package className="mr-1 h-3 w-3" />
                                  {product.initial_quantity}
                                </Badge>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}

                    {showProductDropdown &&
                      !loadingSaleProducts &&
                      activeStoreId &&
                      filteredProducts.length === 0 && (
                        <div className="absolute z-50 mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground shadow-lg">
                          Aucun produit en stock pour ce magasin
                        </div>
                      )}
                  </div>
                </div>

                {/* VARIANT QUANTITIES */}
                {selectedProduct && hasVariants && (
                  <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Quantité à vendre par variante
                    </p>

                    <div className="space-y-2">
                      {sellableVariants.map((v) => {
                        const label =
                          [v.size?.toUpperCase(), v.color].filter(Boolean).join(' / ') ||
                          `Variante #${v.id}`;

                        return (
                          <div
                            key={v.id}
                            className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background px-3 py-2"
                          >
                            <div>
                              <p className="text-sm font-medium">{label}</p>
                              <p className="text-xs text-muted-foreground">
                                Stock disponible : {v.quantity}
                              </p>
                            </div>

                            <Input
                              type="number"
                              min="0"
                              max={v.quantity}
                              placeholder="0"
                              value={variantQuantities[v.id] ?? ''}
                              onChange={(e) =>
                                handleVariantQtyChange(v.id, e.target.value, v.quantity)
                              }
                              className="w-20 text-right"
                            />
                          </div>
                        );
                      })}
                    </div>

                    <p className="pt-1 text-xs text-muted-foreground">
                      Total sélectionné : <strong>{totalVariantQty}</strong> unité(s)
                    </p>
                  </div>
                )}

                {/* STOCK (produits sans variante) */}
                {selectedProduct && !hasVariants && (
                  <div
                    className={`rounded-md p-3 text-sm ${
                      currentStock <= (selectedProduct.alert_threshold || 5)
                        ? 'bg-orange-50 text-orange-700'
                        : 'bg-blue-50 text-blue-700'
                    }`}
                  >
                    Stock disponible : <strong>{currentStock}</strong>
                  </div>
                )}

                {/* QTY + PRICE */}
                <div className={hasVariants ? '' : 'grid grid-cols-2 gap-4'}>
                  {!hasVariants && (
                    <div className="space-y-2">
                      <Label>Quantité</Label>

                      <Input
                        type="number"
                        min="1"
                        max={selectedProduct ? currentStock : undefined}
                        value={quantity}
                        onChange={(e) =>
                          setQuantity(e.target.value)
                        }
                      />
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label>
                      Prix de vente
                      {!isAdmin && (
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                          (non modifiable)
                        </span>
                      )}
                    </Label>

                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={salePrice}
                      readOnly={!isAdmin}
                      disabled={!isAdmin}
                      onChange={(e) => {
                        if (isAdmin) setSalePrice(e.target.value);
                      }}
                      className={!isAdmin ? 'bg-muted cursor-not-allowed' : ''}
                    />
                  </div>
                </div>

                {selectedProduct && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={handleAddToCart}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Ajouter un autre produit
                  </Button>
                )}

                {/* CART */}
                {cart.length > 0 && (
                  <div className="space-y-2 rounded-md border border-border p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Produits du panier ({cart.length})
                    </p>

                    <div className="space-y-2">
                      {cart.map((item) => (
                        <div
                          key={item.key}
                          className="flex items-start justify-between gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
                        >
                          <div>
                            <p className="text-sm font-medium">{item.product.name}</p>
                            {item.hasVariants ? (
                              <p className="text-xs text-muted-foreground">
                                {item.variantLines
                                  ?.map((v) => `${v.label} x${v.quantity}`)
                                  .join(', ')}
                              </p>
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                Quantité : {item.quantity}
                              </p>
                            )}
                            <p className="text-xs text-muted-foreground">
                              {fmt(item.salePrice)} Ar / unité
                            </p>
                          </div>

                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold">
                              {fmt(cartItemAmount(item))} Ar
                            </span>
                            <button
                              type="button"
                              onClick={() => handleRemoveCartItem(item.key)}
                              className="text-muted-foreground hover:text-red-600"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* CUSTOMER */}
                <div className="space-y-2">
                  <Label>Nom du client</Label>

                  <Input
                    placeholder="Nom du client"
                    value={customerName}
                    onChange={(e) =>
                      setCustomerName(e.target.value)
                    }
                  />
                </div>

                {/* PAYMENT */}
                <div className="space-y-2">
                  <Label>Paiement</Label>

                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      variant={
                        isPaid ? 'secondary' : 'outline'
                      }
                      onClick={() => setIsPaid(true)}
                    >
                      Payé
                    </Button>

                    <Button
                      type="button"
                      variant={
                        !isPaid ? 'secondary' : 'outline'
                      }
                      onClick={() => setIsPaid(false)}
                    >
                      Non payé
                    </Button>
                  </div>
                </div>

                {!isPaid && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Montant versé</Label>

                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={paymentAmount}
                        onChange={(e) =>
                          setPaymentAmount(e.target.value)
                        }
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Échéance</Label>

                      <Input
                        type="date"
                        value={paymentDueDate}
                        onChange={(e) =>
                          setPaymentDueDate(e.target.value)
                        }
                      />
                    </div>
                  </div>
                )}

                {!isPaid && paymentDueInfo && (
                  <div
                    className={`rounded-md border p-3 text-sm ${
                      paymentDueInfo.isOverdue
                        ? 'border-red-200 bg-red-50 text-red-700'
                        : 'border-yellow-200 bg-yellow-50 text-yellow-700'
                    }`}
                  >
                    {paymentDueInfo.isOverdue ? (
                      <p>
                        Retard de paiement :{' '}
                        {paymentDueInfo.daysLate} jour(s)
                      </p>
                    ) : (
                      <p>
                        Échéance dans{' '}
                        {paymentDueInfo.daysUntil} jour(s)
                      </p>
                    )}
                  </div>
                )}

                {/* TOTAL */}
                {(cart.length > 0 || (salePrice && (hasVariants ? totalVariantQty > 0 : !!quantity))) && (
                  <div className="rounded-md border border-green-200 bg-green-50 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-green-700">
                        Total {cart.length > 0 ? `(${cart.length} produit${cart.length > 1 ? 's' : ''} au panier${draftAmount > 0 ? ' + sélection en cours' : ''})` : ''}
                      </span>

                      <span className="text-lg font-bold text-green-800">
                        {fmt(cartTotal + draftAmount)} Ar
                      </span>
                    </div>
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full"
                  disabled={submitting || (cart.length === 0 && !hasValidDraft)}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Enregistrement...
                    </>
                  ) : (
                    `Enregistrer la vente${
                      cart.length + (hasValidDraft ? 1 : 0) > 1
                        ? ` (${cart.length + (hasValidDraft ? 1 : 0)} produits)`
                        : ''
                    }`
                  )}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Filtres par date */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col gap-4">
            <Input
              placeholder="Rechercher client, produit, vendeur..."
              className="w-full sm:max-w-md"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="space-y-2 rounded-lg border border-border p-3 sm:p-4">
                <p className="text-sm font-medium">Date de vente</p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    type="date"
                    value={saleStartDate}
                    onChange={(e) => setSaleStartDate(e.target.value)}
                    className="w-full"
                    title="Vente — date début"
                  />
                  <Input
                    type="date"
                    value={saleEndDate}
                    onChange={(e) => setSaleEndDate(e.target.value)}
                    className="w-full"
                    title="Vente — date fin"
                  />
                </div>
              </div>
              <div className="space-y-2 rounded-lg border border-border p-3 sm:p-4">
                <p className="text-sm font-medium">Date d&apos;échéance paiement</p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    type="date"
                    value={dueStartDate}
                    onChange={(e) => setDueStartDate(e.target.value)}
                    className="w-full"
                    title="Échéance — date début"
                  />
                  <Input
                    type="date"
                    value={dueEndDate}
                    onChange={(e) => setDueEndDate(e.target.value)}
                    className="w-full"
                    title="Échéance — date fin"
                  />
                </div>
              </div>
            </div>
            {(saleStartDate || saleEndDate || dueStartDate || dueEndDate) && (
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => {
                  setSaleStartDate('');
                  setSaleEndDate('');
                  setDueStartDate('');
                  setDueEndDate('');
                }}
              >
                Réinitialiser les dates
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* STATS */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShoppingCart className="h-4 w-4 text-blue-500" />
              Aujourd'hui
            </CardTitle>
          </CardHeader>

          <CardContent>
            {loading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <>
                <div className="text-2xl font-bold">
                  {todaySales.length}
                </div>

                
              </>
            )}
          </CardContent>
        </Card>

        {isAdmin && (
          <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <DollarSign className="h-4 w-4 text-green-500" />
              Revenus
            </CardTitle>
          </CardHeader>

          <CardContent>
            {loading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div className="text-xl font-bold">
                {fmt(totalRevenue)} Ar
              </div>
            )}
          </CardContent>
        </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <TrendingUp className="h-4 w-4 text-purple-500" />
              Transactions
            </CardTitle>
          </CardHeader>

          <CardContent>
            {loading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-2xl font-bold">
                {sales.length}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Package className="h-4 w-4 text-orange-500" />
              Unités
            </CardTitle>
          </CardHeader>

          <CardContent>
            {loading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-2xl font-bold">
                {sales.reduce(
                  (sum, sale) => sum + sale.quantity,
                  0
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              Impayées
            </CardTitle>
          </CardHeader>

          <CardContent>
            {loading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-2xl font-bold">
                {unpaidSalesCount}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <DollarSign className="h-4 w-4 text-red-500" />
              Montant dû
            </CardTitle>
          </CardHeader>

          <CardContent>
            {loading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div className="text-xl font-bold">
                {fmt(unpaidSalesAmount)} Ar
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* TABLE */}
      <Card>
        <CardHeader>
          <CardTitle>Historique des ventes</CardTitle>

          <CardDescription>
            {filteredSales.length} vente(s)
          </CardDescription>
        </CardHeader>

        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton
                  key={index}
                  className="h-12 w-full"
                />
              ))}
            </div>
          ) : filteredSales.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <ShoppingCart className="mb-4 h-12 w-12 text-muted-foreground/30" />

              <p className="text-lg font-medium text-muted-foreground">
                Aucune vente enregistrée
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Produit</TableHead>
                    <TableHead className="text-right">
                      Qté
                    </TableHead>
                    <TableHead className="text-right">
                      Prix
                    </TableHead>
                    <TableHead className="text-right">
                      Total
                    </TableHead>
                    <TableHead>Paiement</TableHead>
                    <TableHead>Échéance</TableHead>

                    {isManager && (
                      <TableHead>Vendeur</TableHead>
                    )}

                    {isManager && (
                      <TableHead>Magasin</TableHead>
                    )}

                    <TableHead className="text-right">Ticket</TableHead>

                    {isAdmin && (
                      <TableHead className="text-right">Actions</TableHead>
                    )}
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {filteredSales.map((sale) => (
                    <TableRow key={sale.id}>
                      <TableCell>
                        {formatDate(sale.sold_at)}
                      </TableCell>

                      <TableCell>
                        {sale.customer_name || '—'}
                      </TableCell>

                      <TableCell>
                        <p className="font-medium">
                          {sale.product_name ||
                            `Produit #${sale.product}`}
                        </p>
                        {sale.variant_label && (
                          <p className="text-xs text-muted-foreground">
                            {sale.variant_label}
                          </p>
                        )}
                      </TableCell>

                      <TableCell className="text-right">
                        <Badge variant="secondary">
                          {sale.quantity}
                        </Badge>
                      </TableCell>

                      <TableCell className="text-right">
                        {fmt(Number(sale.sale_price || 0))} Ar
                      </TableCell>

                      <TableCell className="text-right font-semibold">
                        {fmt(Number(sale.total_price || 0))} Ar
                      </TableCell>

                      <TableCell>
                        {sale.is_paid ? (
                          <Badge className="bg-green-600">
                            Payé
                          </Badge>
                        ) : (
                          <Badge variant="destructive">
                            Non payé
                          </Badge>
                        )}
                      </TableCell>

                      <TableCell>
                        {renderPaymentDueDate(sale)}
                      </TableCell>

                      {isManager && (
                        <TableCell>
                          {sale.seller_name || '—'}
                        </TableCell>
                      )}

                      {isManager && (
                        <TableCell>
                          <Badge variant="outline">
                            {sale.shop_name || '-'}
                          </Badge>
                        </TableCell>
                      )}

                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Imprimer le ticket"
                          onClick={() => handlePrintSaleTicket(sale)}
                        >
                          <Printer className="h-4 w-4" />
                        </Button>
                      </TableCell>

                      {isAdmin && (
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setDeletingSale(sale);
                              setDeleteDialogOpen(true);
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete Dialog */}
      <Dialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) setDeletingSale(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer la vente</DialogTitle>
            <DialogDescription>
              Cette action est irréversible.
            </DialogDescription>
          </DialogHeader>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
            >
              Annuler
            </Button>

            <Button
              variant="destructive"
              onClick={handleDeleteSale}
              disabled={deleteLoading}
            >
              {deleteLoading && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Supprimer
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Ticket Dialog */}
      <Dialog open={ticketDialogOpen} onOpenChange={setTicketDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Vente enregistrée</DialogTitle>
            <DialogDescription>
              Ticket {ticketData?.ticketNumber}
            </DialogDescription>
          </DialogHeader>

          {ticketData && (
            <div className="space-y-3 rounded-md border p-3 text-sm">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{ticketData.storeName || 'Boutique'}</span>
                <span>{new Date(ticketData.date).toLocaleString('fr-FR')}</span>
              </div>

              <div className="space-y-1">
                {ticketData.items.map((line, idx) => (
                  <div key={idx} className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{line.name}</p>
                      {line.variantLabel && (
                        <p className="text-xs text-muted-foreground">{line.variantLabel}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {line.quantity} x {fmt(line.unitPrice)} Ar
                      </p>
                    </div>
                    <span className="font-semibold">{fmt(line.total)} Ar</span>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between border-t pt-2 font-bold">
                <span>Total</span>
                <span>{fmt(ticketData.total)} Ar</span>
              </div>

              <div className="text-xs text-muted-foreground">
                Client : {ticketData.customerName || 'Client de passage'} ·{' '}
                {ticketData.isPaid ? 'Payé' : 'Non payé'}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setTicketDialogOpen(false)}>
              Fermer
            </Button>
            <Button onClick={() => ticketData && printTicket(ticketData)}>
              <Printer className="mr-2 h-4 w-4" />
              Imprimer
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}