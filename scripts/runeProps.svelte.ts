/**
 * A props object a test can mutate and a mounted component will react to.
 *
 * `mount()` takes plain props and never looks at them again; only a `$state`
 * proxy makes an update reach the component, and `$state` is a compiler rune
 * that exists solely inside `.svelte` / `.svelte.ts` modules. So the one line
 * that has to live in such a module lives here, and the tests stay `.spec.ts`.
 */
export function runeProps<T extends object>(initial: T): T {
	let props = $state(initial);
	return props;
}
