"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, BookOpen, Info, Search } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/lib/auth/useCurrentUser";
import {
  GUIDE_SECTIONS,
  ROLE_LABELS,
  type AppRole,
  type GuideSection,
} from "./guide-content";

/** Texte indexé pour la recherche : titre, résumé, étapes et notes. */
function haystack(section: GuideSection) {
  return (
    [
      section.title,
      section.summary,
      ...(section.steps ?? []).flatMap((s) => [s.title, ...s.details]),
      ...(section.notes ?? []),
    ]
      .join(" ")
      .toLowerCase()
      // Les accents sont retirés pour que « peremption » trouve « péremption ».
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
  );
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

export default function AidePage() {
  const { user, loading } = useCurrentUser();
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [openItems, setOpenItems] = useState<string[]>([]);

  const role = (user?.role ?? "employer") as AppRole;

  const forMyRole = useMemo(
    () => GUIDE_SECTIONS.filter((s) => s.roles.includes(role)),
    [role],
  );
  const hiddenCount = GUIDE_SECTIONS.length - forMyRole.length;
  // Un compte Label Technology n'a aucune section à son rôle : sans cela la
  // page s'afficherait vide au lieu du guide.
  const everything = showAll || forMyRole.length === 0;

  const sections = useMemo(() => {
    const base = everything ? GUIDE_SECTIONS : forMyRole;
    const q = normalize(query);
    if (!q) return base;
    return base.filter((s) => haystack(s).includes(q));
  }, [everything, forMyRole, query]);

  // Une recherche ouvre les sections trouvées : le mot cherché est presque
  // toujours dans le corps, pas dans le titre, donc tout replier le masquerait.
  const accordionValue = query.trim() ? sections.map((s) => s.id) : openItems;

  const goTo = (id: string) => {
    setOpenItems((prev) => (prev.includes(id) ? prev : [...prev, id]));
    // Laisse le temps à la section de s'ouvrir avant de défiler.
    requestAnimationFrame(() => {
      document
        .getElementById(`section-${id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  if (loading) {
    return (
      <div className="p-4 md:p-6">
        <div className="mx-auto max-w-6xl space-y-4">
          <Skeleton className="h-24 w-full" />
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6">
      <div className="mx-auto w-full space-y-6">
        <header className="space-y-2">
          <h1 className="flex items-center gap-2 text-2xl font-bold md:text-3xl">
            <BookOpen className="h-7 w-7 text-indigo-600" />
            Aide et guide d&apos;utilisation
          </h1>
          <p className="text-sm text-muted-foreground">
            Le fonctionnement complet de l&apos;application, écran par écran.
            {user && (
              <>
                {" "}
                Vous êtes connecté comme{" "}
                <strong>{ROLE_LABELS[role] ?? role}</strong>
                {user.store_name ? <> — {user.store_name}</> : null}.
              </>
            )}
          </p>
        </header>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher : caisse, variante, transfert, impayé…"
              className="pl-9"
              aria-label="Rechercher dans le guide"
            />
          </div>
          {hiddenCount > 0 && forMyRole.length > 0 && (
            <Button
              variant="outline"
              onClick={() => setShowAll((v) => !v)}
              className="shrink-0"
            >
              {everything
                ? "Afficher seulement mon rôle"
                : `Afficher tout (+${hiddenCount})`}
            </Button>
          )}
        </div>

        {!query && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Sommaire</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {sections.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => goTo(s.id)}
                  className="rounded-full border px-3 py-1 text-sm transition hover:bg-muted"
                >
                  {s.title}
                </button>
              ))}
            </CardContent>
          </Card>
        )}

        {sections.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              Aucun résultat pour « {query} ».
              {!everything && hiddenCount > 0 && (
                <>
                  {" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setShowAll(true)}
                  >
                    Chercher aussi dans les sections des autres rôles
                  </button>
                  .
                </>
              )}
            </CardContent>
          </Card>
        ) : (
          <Accordion
            type="multiple"
            value={accordionValue}
            onValueChange={setOpenItems}
            className="space-y-2"
          >
            {sections.map((section) => {
              // Signalé seulement si l'utilisateur a par ailleurs des
              // sections à lui : sinon tout serait badgé pour rien.
              const restricted =
                forMyRole.length > 0 && !section.roles.includes(role);
              return (
                <AccordionItem
                  key={section.id}
                  value={section.id}
                  id={`section-${section.id}`}
                  className="scroll-mt-4 rounded-lg border px-4"
                >
                  <AccordionTrigger className="text-left hover:no-underline">
                    <span className="flex flex-1 flex-wrap items-center gap-2 pr-2">
                      <span className="font-semibold">{section.title}</span>
                      {restricted && (
                        <Badge
                          variant="outline"
                          className="text-[10px] font-normal"
                        >
                          {section.roles.map((r) => ROLE_LABELS[r]).join(" · ")}
                        </Badge>
                      )}
                    </span>
                  </AccordionTrigger>

                  <AccordionContent className="space-y-4 pb-4">
                    <p className="text-sm text-muted-foreground">
                      {section.summary}
                    </p>

                    {section.href && !restricted && (
                      <Button asChild variant="outline" size="sm">
                        <Link href={section.href}>
                          Ouvrir l&apos;écran
                          <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
                        </Link>
                      </Button>
                    )}

                    {section.steps?.map((step) => (
                      <div key={step.title} className="space-y-1.5">
                        <h3 className="text-sm font-semibold">{step.title}</h3>
                        <ul className="space-y-1 pl-4 text-sm leading-relaxed">
                          {step.details.map((detail) => (
                            <li
                              key={detail}
                              className="list-disc marker:text-muted-foreground"
                            >
                              {detail}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}

                    {section.notes && section.notes.length > 0 && (
                      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/20">
                        <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-amber-900 dark:text-amber-300">
                          <Info className="h-4 w-4" />
                          Bon à savoir
                        </div>
                        <ul className="space-y-1 pl-4 text-sm leading-relaxed text-amber-900/90 dark:text-amber-200/90">
                          {section.notes.map((note) => (
                            <li
                              key={note}
                              className="list-disc marker:text-amber-600"
                            >
                              {note}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        )}

        <p className="pb-4 text-center text-xs text-muted-foreground">
          Une question qui n&apos;est pas traitée ici ? Posez-la à
          l&apos;assistant, via la bulle en bas à droite.
        </p>
      </div>
    </div>
  );
}
