"""TLS-only Postbox bridge. Credentials arrive on stdin, never in argv/logs."""
import json
import re
import smtplib
import ssl
import sys
from email.headerregistry import Address
from email.message import EmailMessage
from email.policy import SMTP
from html import escape
from pathlib import Path


def _paragraph(value):
    return re.sub(
        r'https?://[^\s<>"]+',
        lambda match: '<a style="color:#4d3bd4" href="' + match.group(0) + '">' + match.group(0) + '</a>',
        escape(value),
    ).replace("\n", "<br>")


def send(config, smtp_factory=smtplib.SMTP_SSL):
    smtp = None
    started_data = False
    try:
        message = EmailMessage(policy=SMTP)
        message["From"] = Address(display_name="CashNeuro", addr_spec=config["sender"])
        message["Reply-To"] = Address(display_name="Поддержка CashNeuro", addr_spec="support@cashneuro.ru")
        message["To"] = config["to"]
        message["Subject"] = config["subject"]
        message["Message-ID"] = "<" + config["id"] + "@cashneuro.ru>"
        message.set_content(config["text"])
        blocks = "".join("<p style='margin:0 0 16px'>" + _paragraph(part) + "</p>"
                         for part in config["text"].split("\n\n"))
        message.add_alternative(config.get("html") or (
            "<!doctype html><html lang='ru'><body style='margin:0;background:#f3f3fb;color:#19213b'>"
            "<main style='max-width:600px;margin:auto;padding:24px;font:16px/1.55 Arial,sans-serif'>"
            "<div style='padding:18px 22px;background:#4d3bd4;color:white;border-radius:14px 14px 0 0'>"
            "<span aria-hidden='true' style='margin-right:8px'>&#9673;</span><strong>CashNeuro</strong></div>"
            "<div style='background:white;padding:22px;border-radius:0 0 14px 14px'><h1 style='font-size:20px;margin:0 0 16px'>"
            + escape(config["subject"]) + "</h1>" + blocks + "</div></main></body></html>"), subtype="html")
        if config.get("html"):
            part = message.get_payload()[-1]
            part.add_related(Path(__file__).with_name("cashneuro-mail-mark.png").read_bytes(),
                             maintype="image", subtype="png", cid="<cashneuro-mark>", disposition="inline")
        data = message.as_bytes()
        smtp = smtp_factory(
            "postbox.cloud.yandex.net", 465,
            timeout=8, context=ssl.create_default_context(),
        )
        smtp.ehlo_or_helo_if_needed()
        smtp.login(config["username"], config["password"])
        for operation, argument in [(smtp.mail, config["sender"]), (smtp.rcpt, config["to"])]:
            code, _ = operation(argument)
            if code not in (250, 251):
                return {"error": "TEMPORARY" if 400 <= code < 500 else "REJECTED"}
        # Losing a response after DATA could mean accepted: no automatic resend.
        started_data = True
        code, _ = smtp.data(data)
        if code != 250:
            return {"error": "TEMPORARY" if 400 <= code < 500 else "REJECTED"}
        return {"acceptance": "postbox"}
    except smtplib.SMTPResponseException as error:
        return {"error": "TEMPORARY" if 400 <= error.smtp_code < 500 else "REJECTED"}
    except (smtplib.SMTPException, OSError):
        return {"error": "DELIVERY_UNKNOWN" if started_data else "TEMPORARY"}
    except Exception:
        return {"error": "DELIVERY_UNKNOWN" if started_data else "REJECTED"}
    finally:
        if smtp is not None:
            # Acceptance is already known. Failure during QUIT must not undo it.
            try:
                smtp.close()
            except Exception:
                pass


def main():
    try:
        raw = sys.stdin.buffer.read(262145)
        if len(raw) > 262144:
            raise ValueError()
        config = json.loads(raw)
        if set(config) - {"html"} != {"sender", "to", "subject", "text", "id", "username", "password"}:
            raise ValueError()
        if not all(isinstance(value, str) for value in config.values()):
            raise ValueError()
        if not re.fullmatch(r"[0-9a-f-]{36}", config["id"]):
            raise ValueError()
        if any("\r" in config[key] or "\n" in config[key] for key in ["sender", "to", "subject"]):
            raise ValueError()
        print(json.dumps(send(config)))
    except Exception:
        print(json.dumps({"error": "REJECTED"}))


if __name__ == "__main__":
    main()
