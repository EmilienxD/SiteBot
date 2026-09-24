"""The "non-JS site": a single-file Django app serving two pages.

    pip install django
    python site/app.py runserver 8000

It knows nothing about the chat; the pages carry one <script> tag pointing
at the Express sidecar. No Python? `pnpm site:static` serves the same pages.
"""

import sys
from pathlib import Path

from django.conf import settings
from django.core.management import execute_from_command_line
from django.urls import path
from django.views.generic import TemplateView

settings.configure(
    DEBUG=True,
    SECRET_KEY="example-only-not-secret",
    ROOT_URLCONF=__name__,
    ALLOWED_HOSTS=["localhost", "127.0.0.1"],
    TEMPLATES=[
        {
            "BACKEND": "django.template.backends.django.DjangoTemplates",
            "DIRS": [Path(__file__).parent / "pages"],
        }
    ],
)

urlpatterns = [
    path("", TemplateView.as_view(template_name="index.html")),
    path("register/", TemplateView.as_view(template_name="register.html")),
]

if __name__ == "__main__":
    execute_from_command_line(sys.argv)
