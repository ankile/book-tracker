<script lang="ts">
  interface Props {
    icon: { path: string };
    size?: number;
  }

  let { icon, size = 20 }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="currentColor"
  aria-hidden="true"
  focusable="false">
  <path d={icon.path}></path>
</svg>
