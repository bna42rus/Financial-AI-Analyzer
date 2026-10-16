"""TLS-only Postbox bridge. Credentials arrive on stdin, never in argv/logs."""
import json
import re
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.policy import SMTP


def send(config, smtp_factory=smtplib.SMTP_SSL):
    smtp = None
    started_data = False
    try:
        message = EmailMessage(policy=SMTP)
        message["From"] = config["sender"]
        message["To"] = config["to"]
        message["Subject"] = config["subject"]
        message["Message-ID"] = "<" + config["id"] + "@cashneuro.ru>"
        message.set_content(config["text"])
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
        raw = sys.stdin.buffer.read(131073)
        if len(raw) > 131072:
            raise ValueError()
        config = json.loads(raw)
        if set(config) != {"sender", "to", "subject", "text", "id", "username", "password"}:
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
