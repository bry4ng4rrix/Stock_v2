'use client';

import { useEffect, useRef, useState } from 'react';
import { BarChart3, Bot, BookOpen, Check, Loader2, MessageCircle, Send, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { djangoClient, type AssistantMessage, type AssistantPendingAction } from '@/lib/django-client';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { cn } from '@/lib/utils';

/**
 * Bulle d'assistant IA ancrée en bas à droite de toutes les pages de l'app.
 *
 * La conversation vit côté client (le backend est sans état) et survit à la
 * navigation grâce à sessionStorage. Une action proposée par l'assistant
 * (ajustement de stock, prix, transfert) n'est jamais exécutée sans un clic
 * explicite sur « Confirmer » : le backend renvoie un jeton signé, c'est lui
 * qu'on renvoie à l'exécution.
 */

type Bubble = AssistantMessage & { id: string; pending?: AssistantPendingAction[]; status?: 'error' | 'done' };

const STORAGE_KEY = 'assistant.conversation';
const WELCOME =
  "Bonjour ! Je réponds sur votre stock, vos ventes et vos mouvements, j'explique comment " +
  "utiliser l'application, et je peux agir (ajuster un stock, changer un prix, transférer un " +
  "produit) après votre confirmation. Que puis-je faire ?";

/**
 * Messages de démarrage proposés tant que la conversation est vierge.
 *
 * Deux familles volontairement mélangées : « guide » (le fonctionnement de
 * l'app, servi par l'outil guide_app) et « données » (les chiffres réels du
 * magasin). C'est ce qui montre d'emblée que l'assistant sait faire les deux —
 * sans exemples, les utilisateurs ne posent que des questions de stock.
 *
 * Les listes suivent les mêmes droits que le guide : inutile de proposer un
 * transfert à un gérant, l'écran ne lui est pas accessible.
 */
type Suggestion = { kind: 'guide' | 'data'; label: string; prompt: string };

const SUGGESTIONS_COMMON: Suggestion[] = [
  { kind: 'guide', label: 'Enregistrer une vente', prompt: 'Comment enregistrer une vente ?' },
  { kind: 'guide', label: 'Ouvrir la caisse', prompt: 'Comment ouvrir et fermer la caisse ?' },
  { kind: 'data', label: 'Produits en alerte', prompt: 'Quels produits sont en alerte de stock ?' },
  { kind: 'data', label: 'Résumé du stock', prompt: 'Fais-moi un résumé de mon stock.' },
];

const SUGGESTIONS_MANAGERS: Suggestion[] = [
  { kind: 'data', label: 'Ventes de la semaine', prompt: 'Quelles sont mes ventes des 7 derniers jours ?' },
  { kind: 'guide', label: 'Réapprovisionner', prompt: 'Comment ajouter du stock à un produit existant ?' },
  { kind: 'guide', label: 'Gérer les variantes', prompt: 'Comment fonctionnent les variantes taille et couleur ?' },
  { kind: 'data', label: 'Derniers mouvements', prompt: 'Montre-moi les derniers mouvements de stock.' },
];

const SUGGESTIONS_ADMIN: Suggestion[] = [
  { kind: 'guide', label: 'Transférer un produit', prompt: 'Comment transférer un produit vers un autre magasin ?' },
  { kind: 'guide', label: 'Créer un compte', prompt: "Comment créer et approuver le compte d'un gérant ?" },
];

const SUGGESTIONS_EMPLOYER: Suggestion[] = [
  { kind: 'guide', label: 'Scanner un produit', prompt: 'Comment scanner le QR code d\'un produit ?' },
  { kind: 'guide', label: 'Ce que je peux faire', prompt: 'Que puis-je faire avec mon rôle employé ?' },
];

function suggestionsFor(role: string | undefined): Suggestion[] {
  if (role === 'admin') return [...SUGGESTIONS_COMMON, ...SUGGESTIONS_MANAGERS, ...SUGGESTIONS_ADMIN];
  if (role === 'magasin') return [...SUGGESTIONS_COMMON, ...SUGGESTIONS_MANAGERS];
  return [...SUGGESTIONS_COMMON, ...SUGGESTIONS_EMPLOYER];
}

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function AssistantBubble() {
  const { user } = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [executing, setExecuting] = useState<string | null>(null);
  const [messages, setMessages] = useState<Bubble[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        setMessages(JSON.parse(stored));
        return;
      }
    } catch {
      /* stockage indisponible : on repart d'une conversation vide */
    }
    setMessages([{ id: newId(), role: 'assistant', content: WELCOME }]);
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-40)));
    } catch {
      /* ignoré */
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);

  // L'assistant ne concerne pas le super-admin de la plateforme.
  if (!user || user.role === 'platform_admin') return null;

  const canAct = user.role === 'admin' || user.role === 'magasin';
  const suggestions = suggestionsFor(user.role);
  // Uniquement sur une conversation vierge : une fois l'échange engagé, ces
  // puces prendraient la place des messages dans une fenêtre déjà étroite.
  const showSuggestions = !busy && messages.length <= 1;
  const magasinId = user.role === 'admin' ? null : (user.magasin_id ?? user.store_id ?? null);

  // `preset` : texte imposé par un clic sur une suggestion. Sans lui, on prend
  // le contenu du champ de saisie.
  const send = async (preset?: string) => {
    const text = (preset ?? input).trim();
    if (!text || busy) return;
    if (!preset) setInput('');
    const userMessage: Bubble = { id: newId(), role: 'user', content: text };
    const history = [...messages, userMessage];
    setMessages(history);
    setBusy(true);
    try {
      // Le message d'accueil n'est pas envoyé : il n'apporte rien au modèle.
      const payload = history
        .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content !== WELCOME))
        .map(({ role, content }) => ({ role, content }));
      const res = await djangoClient.assistant.chat(payload, magasinId);
      setMessages((prev) => [
        ...prev,
        { id: newId(), role: 'assistant', content: res.reply, pending: res.pending_actions },
      ]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Erreur inconnue';
      setMessages((prev) => [
        ...prev,
        { id: newId(), role: 'assistant', content: `Désolé, je n'ai pas pu répondre : ${detail}`, status: 'error' },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (messageId: string, action: AssistantPendingAction) => {
    setExecuting(action.token);
    try {
      const res = await djangoClient.assistant.execute(action.token);
      const summary = Object.entries(res.result ?? {})
        .filter(([key]) => key !== 'movement_id')
        .map(([key, value]) => `${key.replace(/_/g, ' ')} : ${Array.isArray(value) ? value.join(', ') : String(value)}`)
        .join('\n');
      setMessages((prev) => [
        ...prev.map((m) => (m.id === messageId ? { ...m, pending: m.pending?.filter((p) => p.token !== action.token) } : m)),
        { id: newId(), role: 'assistant', content: `Fait : ${action.description}\n${summary}`.trim(), status: 'done' },
      ]);
      window.dispatchEvent(new CustomEvent('assistant:action-executed', { detail: res }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Erreur inconnue';
      setMessages((prev) => [
        ...prev,
        { id: newId(), role: 'assistant', content: `L'action n'a pas été exécutée : ${detail}`, status: 'error' },
      ]);
    } finally {
      setExecuting(null);
    }
  };

  const dismiss = (messageId: string, action: AssistantPendingAction) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, pending: m.pending?.filter((p) => p.token !== action.token) } : m)),
    );
  };

  const reset = () => {
    setMessages([{ id: newId(), role: 'assistant', content: WELCOME }]);
  };

  return (
    <>
      {open && (
        <div
          className="fixed bottom-24 right-4 z-50 flex h-[min(560px,calc(100vh-7rem))] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl"
          role="dialog"
          aria-label="Assistant"
        >
          <div className="flex items-center gap-2 border-b bg-indigo-600 px-4 py-3 text-white">
            <Bot className="h-5 w-5" />
            <div className="flex-1 leading-tight">
              <div className="text-sm font-semibold">Assistant</div>
              <div className="text-[11px] opacity-80">
                {canAct ? 'Questions et actions (avec confirmation)' : 'Questions sur le stock et les ventes'}
              </div>
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-white hover:bg-white/15" onClick={reset} title="Nouvelle conversation">
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-white hover:bg-white/15" onClick={() => setOpen(false)} title="Fermer">
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {messages.map((m) => (
              <div key={m.id} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed',
                    m.role === 'user'
                      ? 'bg-indigo-600 text-white rounded-br-sm'
                      : m.status === 'error'
                        ? 'bg-destructive/10 text-destructive rounded-bl-sm'
                        : m.status === 'done'
                          ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200 rounded-bl-sm'
                          : 'bg-muted rounded-bl-sm',
                  )}
                >
                  {m.content}
                  {m.pending && m.pending.length > 0 && (
                    <div className="mt-2 space-y-2 border-t border-black/10 pt-2 dark:border-white/10">
                      {m.pending.map((action) => (
                        <div key={action.token} className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            className="h-7 bg-emerald-600 text-white hover:bg-emerald-700"
                            disabled={executing !== null}
                            onClick={() => confirm(m.id, action)}
                          >
                            {executing === action.token ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
                            Confirmer
                          </Button>
                          <Button size="sm" variant="outline" className="h-7" disabled={executing !== null} onClick={() => dismiss(m.id, action)}>
                            Annuler
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {showSuggestions && (
              <div className="space-y-2 pt-1">
                <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Pour commencer
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {suggestions.map((s) => (
                    <button
                      key={s.prompt}
                      type="button"
                      onClick={() => void send(s.prompt)}
                      disabled={busy}
                      title={s.prompt}
                      className={cn(
                        'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition',
                        'hover:border-indigo-400 hover:bg-indigo-50 disabled:opacity-50 dark:hover:bg-indigo-950/40',
                        s.kind === 'guide'
                          ? 'border-indigo-200 text-indigo-700 dark:border-indigo-900 dark:text-indigo-300'
                          : 'border-emerald-200 text-emerald-700 dark:border-emerald-900 dark:text-emerald-300',
                      )}
                    >
                      {s.kind === 'guide' ? <BookOpen className="h-3 w-3" /> : <BarChart3 className="h-3 w-3" />}
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {busy && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  L'assistant réfléchit… (cela peut prendre une minute)
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <form
            className="flex items-end gap-2 border-t p-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Ex. : combien de Strasse en stock ? / ajoute 5 Strasse reçues"
              rows={2}
              className="min-h-0 resize-none text-sm"
              disabled={busy}
            />
            <Button type="submit" size="icon" disabled={busy || !input.trim()} className="h-10 w-10 shrink-0 bg-indigo-600 hover:bg-indigo-700">
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        aria-label={open ? "Fermer l'assistant" : "Ouvrir l'assistant"}
        title="Assistant"
      >
        {open ? <X className="h-6 w-6" /> : <MessageCircle className="h-6 w-6" />}
      </button>
    </>
  );
}
