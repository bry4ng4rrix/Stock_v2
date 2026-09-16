import os
from pathlib import Path

# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent


def bool_env(value, default=False):
    if value is None:
        return default
    return str(value).lower() in ("1", "true", "yes", "on")


# Quick-start development settings - unsuitable for production
# See https://docs.djangoproject.com/en/5.2/howto/deployment/checklist/

# SECURITY WARNING: keep the secret key used in production secret!
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "django-insecure-dev-key")

# SECURITY WARNING: don't run with debug turned on in production!
DEBUG = bool_env(os.environ.get("DEBUG", "False"))



# Application definition

INSTALLED_APPS = [
    'daphne',
    'channels',
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    "rest_framework_simplejwt",
    'rest_framework',
    'users',
    'corsheaders',
]

AUTH_USER_MODEL = "users.CustomUser"

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
     "whitenoise.middleware.WhiteNoiseMiddleware",
]

ROOT_URLCONF = 'Stock.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'Stock.wsgi.application'
ASGI_APPLICATION = 'Stock.asgi.application'

# Redis (cache, sessions, Channels layer). Falls back to a local Redis on the
# default port so a bare (non-Docker) run still works; docker-compose sets
# REDIS_URL to the "redis" service hostname.
REDIS_URL = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0")

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [REDIS_URL],
        },
    },
}

CACHES = {
    "default": {
        "BACKEND": "django_redis.cache.RedisCache",
        # Separate DB index from the Channels layer above so cache flushes
        # (cache.clear()) never wipe pub/sub channel state, and vice versa.
        "LOCATION": os.environ.get("REDIS_CACHE_URL", REDIS_URL.rsplit("/", 1)[0] + "/1"),
        "OPTIONS": {
            "CLIENT_CLASS": "django_redis.client.DefaultClient",
        },
        "KEY_PREFIX": "stockv2",
    }
}

# Django-admin sessions only (API auth is JWT, not session-based) — moving
# them to Redis just takes load off the DB for /admin/ traffic.
SESSION_ENGINE = "django.contrib.sessions.backends.cache"
SESSION_CACHE_ALIAS = "default"


# Database
# https://docs.djangoproject.com/en/5.2/ref/settings/#databases

DATABASE_ENGINE = os.environ.get("DB_ENGINE", "django.db.backends.sqlite3")
if DATABASE_ENGINE == "django.db.backends.postgresql":
    DATABASES = {
        "default": {
            "ENGINE": DATABASE_ENGINE,
            "NAME": os.environ.get("DB_NAME", "stock_db"),
            "USER": os.environ.get("DB_USER", "stock"),
            "PASSWORD": os.environ.get("DB_PASSWORD", "stock"),
            "HOST": os.environ.get("DB_HOST", "db"),
            "PORT": os.environ.get("DB_PORT", "5432"),
            # Reuse connections across requests instead of opening a fresh
            # TCP+auth handshake per request (the default for SQLite, where
            # this cost doesn't exist, was 0 — no pooling).
            "CONN_MAX_AGE": 600,
            "CONN_HEALTH_CHECKS": True,
        }
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        }
    }

MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

STATIC_URL = 'static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'

# Password validation
# https://docs.djangoproject.com/en/5.2/ref/settings/#auth-password-validators

AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]


# Internationalization
# https://docs.djangoproject.com/en/5.2/topics/i18n/

LANGUAGE_CODE = 'en-us'

TIME_ZONE = 'UTC'

USE_I18N = True

USE_TZ = True


# Static files (CSS, JavaScript, Images)
# https://docs.djangoproject.com/en/5.2/howto/static-files/

# Default primary key field type
# https://docs.djangoproject.com/en/5.2/ref/settings/#default-auto-field

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'


REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': (
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ),
}



ALLOWED_HOSTS = os.environ.get("ALLOWED_HOSTS", "157.173.103.147 localhost 127.0.0.1").split()

CORS_ALLOW_ALL_ORIGINS = False

_cors_env = os.environ.get("CORS_ALLOWED_ORIGINS", "")
CORS_ALLOWED_ORIGINS = _cors_env.split() if _cors_env else [
    "http://localhost:3000",
    "http://157.173.103.147:3000",
    "http://157.173.103.147",
]

_csrf_env = os.environ.get("CSRF_TRUSTED_ORIGINS", "")
CSRF_TRUSTED_ORIGINS = _csrf_env.split() if _csrf_env else [
    "http://157.173.103.147",
    "http://157.173.103.147:3000",
    "http://157.173.103.147:8000",
]


# =====================================
# RAPPROCHEMENT DE PRODUITS PAR IA (OLLAMA)
# =====================================
# Utilisé lors des transferts entre magasins pour reconnaître qu'une fiche
# existe déjà à destination (même nom / référence / description / prix) et
# additionner les quantités au lieu de créer un doublon. Voir
# users/ai_matching.py. Tout est désactivable sans redéploiement de code via
# AI_PRODUCT_MATCHING_ENABLED : le transfert retombe alors sur le
# rapprochement déterministe (nom + référence identiques).

# Ollama tourne sur l'hôte du VPS, hors du conteneur : on l'atteint par la
# passerelle du réseau Docker du service `backend`, pas par 127.0.0.1 (qui
# désignerait le conteneur) ni par 172.17.0.1 (passerelle du bridge "default"
# — le service `backend` tourne sur le réseau compose dédié "stock_v2_default",
# dont la passerelle est 172.18.0.1 ; vérifier avec
# `docker network inspect stock_v2_default` si ça change un jour).
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://172.18.0.1:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:4b")
OLLAMA_TIMEOUT = float(os.environ.get("OLLAMA_TIMEOUT", "20"))

AI_PRODUCT_MATCHING_ENABLED = bool_env(os.environ.get("AI_PRODUCT_MATCHING_ENABLED", "True"), True)
# En dessous de ce seuil la proposition du modèle est ignorée : mieux vaut un
# doublon (corrigeable à la main) qu'une fusion erronée de deux stocks.
AI_MATCH_MIN_CONFIDENCE = float(os.environ.get("AI_MATCH_MIN_CONFIDENCE", "0.7"))
# Nombre de fiches soumises au modèle en une fois.
AI_MATCH_MAX_CANDIDATES = int(os.environ.get("AI_MATCH_MAX_CANDIDATES", "25"))
# Budget de temps cumulé pour un transfert entier, afin qu'un lot de vingt
# produits ne puisse pas immobiliser la requête HTTP.
AI_MATCH_TIME_BUDGET = float(os.environ.get("AI_MATCH_TIME_BUDGET", "45"))

# =====================================
# ASSISTANT CONVERSATIONNEL (OLLAMA)
# =====================================
# Bulle d'assistance dans l'application (web et mobile) : questions sur le
# stock/ventes et actions confirmées, toutes journalisées dans Movement.
# Voir users/assistant.py.
AI_ASSISTANT_ENABLED = bool_env(os.environ.get("AI_ASSISTANT_ENABLED", "True"), True)
# Modèle dédié à l'assistant (par défaut le même que le rapprochement). Il
# doit supporter l'appel d'outils ("tools") : qwen3 le fait, qwen2.5:0.5b aussi.
OLLAMA_ASSISTANT_MODEL = os.environ.get("OLLAMA_ASSISTANT_MODEL", OLLAMA_MODEL)
# Un tour de conversation peut enchaîner jusqu'à trois appels au modèle, et
# sur CPU chacun prend des dizaines de secondes : timeout par appel généreux.
OLLAMA_ASSISTANT_TIMEOUT = float(os.environ.get("OLLAMA_ASSISTANT_TIMEOUT", "120"))
