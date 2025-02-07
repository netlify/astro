import { ActionError, deserializeActionResult, getActionQueryString } from 'astro:actions';

function toActionProxy(actionCallback = {}, aggregatedPath = '') {
	return new Proxy(actionCallback, {
		get(target, objKey) {
			if (objKey in target || typeof objKey === 'symbol') {
				return target[objKey];
			}
			const path = aggregatedPath + objKey.toString();
			function action(param) {
				return handleAction(param, path, this);
			}

			Object.assign(action, {
				queryString: getActionQueryString(path),
				toString: () => action.queryString,
				// Progressive enhancement info for React.
				$$FORM_ACTION: function () {
					return {
						method: 'POST',
						// `name` creates a hidden input.
						// It's unused by Astro, but we can't turn this off.
						// At least use a name that won't conflict with a user's formData.
						name: '_astroAction',
						action: action.toString(),
					};
				},
				// Note: `orThrow` does not have progressive enhancement info.
				// If you want to throw exceptions,
				//  you must handle those exceptions with client JS.
				async orThrow(param) {
					const { data, error } = await handleAction(param, path, this);
					if (error) throw error;
					return data;
				},
			});

			// recurse to construct queries for nested object paths
			// ex. actions.user.admins.auth()
			return toActionProxy(action, path + '.');
		},
	});
}

/**
 * @param {*} param argument passed to the action when called server or client-side.
 * @param {string} path Built path to call action by path name.
 * @param {import('../dist/@types/astro.d.ts').APIContext | undefined} context Injected API context when calling actions from the server.
 * Usage: `actions.[name](param)`.
 * @returns {Promise<import('../dist/actions/runtime/virtual/shared.js').SafeResult<any, any>>}
 */
async function handleAction(param, path, context) {
	// When running server-side, import the action and call it.
	if (import.meta.env.SSR) {
		const { getAction } = await import('astro/actions/runtime/virtual/get-action.js');
		const action = await getAction(path);
		if (!action) throw new Error(`Action not found: ${path}`);

		return action.bind(context)(param);
	}

	// When running client-side, make a fetch request to the action path.
	const headers = new Headers();
	headers.set('Accept', 'application/json');
	let body = param;
	if (!(body instanceof FormData)) {
		try {
			body = param ? JSON.stringify(param) : undefined;
		} catch (e) {
			throw new ActionError({
				code: 'BAD_REQUEST',
				message: `Failed to serialize request body to JSON. Full error: ${e.message}`,
			});
		}
		headers.set('Content-Type', 'application/json');
		headers.set('Content-Length', body?.length.toString() ?? '0');
	}
	const rawResult = await fetch(`/_actions/${path}`, {
		method: 'POST',
		body,
		headers,
	});
	if (rawResult.status === 204) return;

	return deserializeActionResult({
		type: rawResult.ok ? 'data' : 'error',
		body: await rawResult.text(),
	});
}

export const actions = toActionProxy();
