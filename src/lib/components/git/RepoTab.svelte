<script lang="ts">
  import { cn } from "../../utils";

  const {
    tabValue,
    label,
    href,
    icon,
    activeTab,
  }: {
    tabValue: string;
    label: string;
    href: string;
    icon?: any;
    activeTab: string;
  } = $props();

  const isActive = activeTab === tabValue;

  function ensureVisible(node: HTMLElement, active: boolean) {
    let raf = 0;

    const scrollIfNeeded = (isActive: boolean) => {
      if (!isActive) return;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        node.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    };

    scrollIfNeeded(active);

    return {
      update: scrollIfNeeded,
      destroy: () => {
        if (raf) cancelAnimationFrame(raf);
      },
    };
  }
</script>

<a
  href={href}
  use:ensureVisible={isActive}
  class={cn(
    "ring-offset-background focus-visible:ring-ring data-[state=active]:bg-background data-[state=active]:text-foreground inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm w-full",
    isActive ? "bg-background text-foreground" : "text-muted-foreground"
  )}
  data-state={isActive ? "active" : undefined}
  aria-current={isActive ? "page" : undefined}
  tabindex="0"
>
  <span class="flex items-center gap-1">
    {@render icon?.()}
    <span class="relative">{label}</span>
  </span>
</a>
