(() => {
    const storageKey = 'handyman.supabase.session';
    let configPromise;

    function readSession() {
        for (const storage of [localStorage, sessionStorage]) {
            const value = storage.getItem(storageKey);
            if (value) {
                try {
                    return { session: JSON.parse(value), storage };
                } catch {
                    storage.removeItem(storageKey);
                }
            }
        }
        return null;
    }

    function saveSession(session, persistent) {
        const storage = persistent ? localStorage : sessionStorage;
        const otherStorage = persistent ? sessionStorage : localStorage;
        session.expires_at = Math.floor(Date.now() / 1000) + session.expires_in;
        otherStorage.removeItem(storageKey);
        storage.setItem(storageKey, JSON.stringify(session));
    }

    function clearSession() {
        localStorage.removeItem(storageKey);
        sessionStorage.removeItem(storageKey);
    }

    async function getConfig() {
        if (!configPromise) {
            configPromise = fetch('/api/config')
                .then(async response => {
                    if (!response.ok) throw new Error('No se pudo cargar la configuración de Supabase.');
                    return response.json();
                })
                .catch(error => {
                    configPromise = null;
                    throw error;
                });
        }
        return configPromise;
    }

    class AuthError extends Error {
        constructor(message, status) {
            super(message);
            this.status = status;
        }
    }

    async function authRequest(grant, credentials) {
        const config = await getConfig();
        let response;
        try {
            response = await fetch(
                `${config.supabaseUrl}/auth/v1/token?grant_type=${encodeURIComponent(grant)}`,
                {
                    method: 'POST',
                    headers: {
                        apikey: config.publishableKey,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(credentials)
                }
            );
        } catch {
            throw new Error('No se pudo conectar con Supabase. Revisa tu conexión e inténtalo de nuevo.');
        }

        const result = await response.json();
        if (!response.ok) {
            throw new AuthError(
                response.status === 400 || response.status === 401
                    ? 'No se pudo iniciar sesión. Verifica tu correo y contraseña.'
                    : 'El servicio de autenticación no está disponible. Intenta de nuevo.',
                response.status
            );
        }
        return result;
    }

    async function refreshSession(entry) {
        const session = await authRequest('refresh_token', {
            refresh_token: entry.session.refresh_token
        });
        saveSession(session, entry.storage === localStorage);
        return session;
    }

    async function getAccessToken() {
        const entry = readSession();
        if (!entry) {
            window.location.replace('/login.html');
            throw new Error('Inicia sesión para continuar.');
        }
        if (entry.session.expires_at > Math.floor(Date.now() / 1000) + 30) {
            return entry.session.access_token;
        }
        try {
            return (await refreshSession(entry)).access_token;
        } catch (error) {
            if (!(error instanceof AuthError) || (error.status !== 400 && error.status !== 401)) {
                throw error;
            }
            clearSession();
            window.location.replace('/login.html');
            throw new Error('Tu sesión expiró. Inicia sesión de nuevo.');
        }
    }

    async function signIn(email, password, persistent) {
        const session = await authRequest('password', { email, password });
        saveSession(session, persistent);
    }

    async function request(path, options = {}) {
        let accessToken = await getAccessToken();
        const send = token => fetch(path, {
            method: options.method || 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
                ...(options.body ? { 'Content-Type': 'application/json' } : {})
            },
            ...(options.body ? { body: JSON.stringify(options.body) } : {})
        });
        let response = await send(accessToken);

        if (response.status === 401) {
            const entry = readSession();
            try {
                if (!entry) throw new Error('La sesión ya no está disponible.');
                accessToken = (await refreshSession(entry)).access_token;
            } catch (error) {
                if (!(error instanceof AuthError) || (error.status !== 400 && error.status !== 401)) {
                    throw error;
                }
                clearSession();
                window.location.replace('/login.html');
                throw new Error('Tu sesión expiró. Inicia sesión de nuevo.');
            }
            response = await send(accessToken);
        }

        const result = response.status === 204 ? null : await response.json();
        if (!response.ok) {
            throw new Error(result?.error || 'No se pudo completar la solicitud.');
        }
        return result;
    }

    async function signOut() {
        const entry = readSession();
        clearSession();
        if (!entry) return;

        const config = await getConfig();
        const response = await fetch(`${config.supabaseUrl}/auth/v1/logout`, {
            method: 'POST',
            headers: {
                apikey: config.publishableKey,
                Authorization: `Bearer ${entry.session.access_token}`
            }
        });
        if (!response.ok) {
            throw new Error('Se cerró la sesión en este dispositivo, pero no se pudo revocar el token remoto.');
        }
    }

    window.supabaseAuth = { signIn, getAccessToken, request, signOut };
})();
