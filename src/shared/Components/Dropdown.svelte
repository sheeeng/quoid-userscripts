<script>
	import IconButton from "./IconButton.svelte";

	export let icon = "plus";
	export let disabled = false;
	export let title;
	export let right = false;

	let active = false;

	function dropdownClick(event) {
		// button clicks toggle active var which controls dropdown display
		active = !active;
		// add event listener to body when dropdown opens
		// this enables off-clicking to close dropdown
		// add named function so it can be removed when dropdown closes
		document.body.addEventListener("click", function _a(e) {
			// button click events bubble to document body
			// can use to determine if button triggered body event listener func
			// event.target = button, e.target = body event listener trigger el
			if (e.target !== event.target) {
				// the body event listener not triggered by button
				// if omitted, dropdown would close immediately
				active = false;
				document.body.removeEventListener("click", _a);
			} else if (!active) {
				// !active normally means dropdown is not open
				// however, since active is toggled before this func is run
				// in this case !active means dropdown is open

				// remove body event listener when dropdown is closed by button
				// if omitted, multiple body event listeners would be added
				document.body.removeEventListener("click", _a);
			}
		});
	}
</script>

<div class:active>
	<IconButton {icon} on:click={dropdownClick} {title} {disabled} />
	<ul class:right>
		<slot>
			<li>At least one slot is required...</li>
		</slot>
	</ul>
</div>

<style>
	div {
		position: relative;
		z-index: 86;
	}

	ul {
		background-color: var(--color-bg-theme);
		border: 1px solid var(--border-color);
		border-radius: var(--border-radius);
		box-shadow: var(--box-shadow);
		color: var(--text-color-secondary);
		display: none;
		font: var(--text-medium);
		left: 0;
		padding: 0.125rem;
		position: absolute;
		top: 100%;
		white-space: nowrap;
	}

	ul.right {
		left: auto;
		right: 0;
	}

	.active ul {
		display: flex;
		flex-direction: column;
	}

	ul :global(li) {
		border-radius: 2px;
		cursor: pointer;
		padding: 0.5rem 1rem;
	}

	.active :global(button svg) {
		opacity: 1;
	}

	ul :global(li.separator) {
		background-color: black;
		height: 1px;
		margin: 0.25rem 0.5rem;
		padding: 0;
	}

	ul :global(li.selected) {
		color: var(--text-color-disabled);
		pointer-events: none;
	}

	ul :global(li:hover:not(.separator)) {
		background-color: var(--color-blue);
		color: light-dark(var(--color-white), var(--color-black));
	}

	ul :global(button) {
		text-align: left;
		background: none;
		color: var(--text-color-primary);
		width: 100%;
		border-radius: 2px;
		padding: 0.5rem 1rem;
	}

	ul :global(button.selected) {
		/* color: var(--text-color-disabled); */
	}

	ul :global(button:hover) {
		background-color: var(--color-blue);
		color: light-dark(var(--color-white), var(--color-black));
	}

	ul :global(button:active) {
		opacity: 0.75;
	}
</style>
