import importlib.util
import pathlib
import smtplib
import ssl
import unittest
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("postbox_smtp", pathlib.Path(__file__).parent.parent / "src/postbox-smtp.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
CONFIG = {"sender":"notifications@cashneuro.ru", "to":"inbox@example.org", "subject":"Проверка",
          "text":"Синтетика", "id":"01234567-1234-1234-1234-123456789abc", "username":"synthetic", "password":"synthetic"}


class SMTP:
    def __init__(self, stage=None, response=250):
        self.stage, self.response, self.closed, self.data_bytes = stage, response, False, b""
    def ehlo_or_helo_if_needed(self):
        pass
    def login(self, username, password):
        if self.stage == "auth":
            raise smtplib.SMTPAuthenticationError(535, b"SECRET")
    def mail(self, value):
        if self.stage == "mail":
            raise OSError("SECRET")
        return 250, b"ok"
    def rcpt(self, value):
        return (450 if self.stage == "rcpt" else 250), b"SECRET"
    def data(self, value):
        self.data_bytes = value
        if self.stage == "data":
            raise smtplib.SMTPServerDisconnected("SECRET")
        return self.response, b"SECRET"
    def close(self):
        self.closed = True
        if self.stage == "close":
            raise OSError("SECRET")


class Tests(unittest.TestCase):
    def run_send(self, smtp):
        def factory(host, port, timeout, context):
            self.assertEqual((host,port), ("postbox.cloud.yandex.net",465))
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(context.check_hostname)
            self.assertLess(timeout, 15)
            return smtp
        result = module.send(CONFIG, factory)
        self.assertTrue(smtp.closed)
        return result
    def test_acceptance_survives_close_failure_and_uses_safe_mime(self):
        smtp = SMTP("close")
        self.assertEqual(self.run_send(smtp), {"acceptance":"postbox"})
        self.assertIn(b"Content-Transfer-Encoding:", smtp.data_bytes)
        self.assertIn(b"Message-ID: <01234567-1234-1234-1234-123456789abc@cashneuro.ru>", smtp.data_bytes)
    def test_safe_retry_before_data(self):
        for stage in ["mail","rcpt"]:
            self.assertEqual(self.run_send(SMTP(stage)), {"error":"TEMPORARY"})
    def test_no_retry_after_lost_data_reply(self):
        self.assertEqual(self.run_send(SMTP("data")), {"error":"DELIVERY_UNKNOWN"})
    def test_explicit_data_rejection(self):
        self.assertEqual(self.run_send(SMTP(response=451)), {"error":"TEMPORARY"})
        self.assertEqual(self.run_send(SMTP(response=554)), {"error":"REJECTED"})
    def test_auth_failure_is_permanent(self):
        self.assertEqual(self.run_send(SMTP("auth")), {"error":"REJECTED"})


if __name__ == "__main__":
    unittest.main()
