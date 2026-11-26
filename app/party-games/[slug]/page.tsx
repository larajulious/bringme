import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { GuidePage } from "@/components/marketing/guide-page";
import { GUIDES, getGuide, guidePath } from "@/lib/site/guides";
import { pageMeta } from "@/lib/site/seo";

type Props = { params: Promise<{ slug: string }> };

/** Every guide is prerendered; unknown slugs 404 (dynamicParams isn't allowed with Cache Components). */
export function generateStaticParams() {
  return GUIDES.map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const guide = getGuide((await params).slug);
  if (!guide) return {};
  return pageMeta({ title: guide.metaTitle, description: guide.description, path: guidePath(guide.slug) });
}

export default async function Page({ params }: Props) {
  const guide = getGuide((await params).slug);
  if (!guide) notFound();
  return <GuidePage guide={guide} />;
}
