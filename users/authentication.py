from rest_framework_simplejwt.serializers import TokenObtainPairSerializer, TokenRefreshSerializer
from rest_framework_simplejwt.exceptions import AuthenticationFailed
from rest_framework_simplejwt.tokens import RefreshToken

from .models import LoginEvent, CustomUser
from .subscriptions import is_login_allowed, BLOCKED_MESSAGE, get_client_ip, get_or_register_device


class CustomTokenObtainPairSerializer(TokenObtainPairSerializer):

    def validate(self, attrs):
        data = super().validate(attrs)

        if not self.user.is_confirmed:
            raise AuthenticationFailed(
                "Compte non approuvé. Contactez votre administrateur.",
                code="account_not_approved",
            )

        if not is_login_allowed(self.user):
            raise AuthenticationFailed(
                BLOCKED_MESSAGE,
                code="subscription_inactive",
            )

        request = self.context.get("request")
        ip_address = get_client_ip(request) if request else None
        user_agent = request.META.get("HTTP_USER_AGENT", "")[:500] if request else ""

        if request is not None:
            try:
                LoginEvent.objects.create(
                    user=self.user,
                    ip_address=ip_address,
                    user_agent=user_agent,
                )
            except Exception:
                pass

        device_id = (request.data.get("device_id") if request is not None else None) or None
        device, created, limit_exceeded = get_or_register_device(self.user, device_id, ip_address, user_agent)

        if limit_exceeded:
            from .subscriptions import get_device_limit_info
            count, limit = get_device_limit_info(self.user)
            raise AuthenticationFailed(
                f"Limite d'appareils atteinte ({count}/{limit}). "
                "Supprimez un appareil existant ou contactez Label Technology pour augmenter votre offre.",
                code="device_limit_exceeded",
            )

        data["device_status"] = "new" if created else ("known" if device else None)

        return data


class CustomTokenRefreshSerializer(TokenRefreshSerializer):
    """Re-checks subscription status on every token refresh, so an account
    blocked mid-session (e.g. trial expiring) gets logged out promptly
    instead of only being caught on the next full login."""

    def validate(self, attrs):
        data = super().validate(attrs)

        try:
            refresh = RefreshToken(attrs["refresh"])
            user = CustomUser.objects.get(id=refresh["user_id"])
        except Exception:
            return data

        if not is_login_allowed(user):
            raise AuthenticationFailed(
                BLOCKED_MESSAGE,
                code="subscription_inactive",
            )

        return data