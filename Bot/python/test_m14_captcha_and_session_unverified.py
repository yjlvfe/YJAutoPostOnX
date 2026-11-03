"""Test M14: CAPTCHA and unverified session classification invariants."""
import unittest
from direct_x_compat import classify_x_account_failure

class TestM14CaptchaAndUnverified(unittest.TestCase):
    def test_auth_session_unverified_not_classified_as_banned_or_cookie_expired(self):
        # When an account is unverified without explicit 64/326/89, must return auth_session_unverified
        self.assertEqual(classify_x_account_failure(text='auth_session_unverified'), 'auth_session_unverified')
        self.assertEqual(classify_x_account_failure(text='auth_account_state_unverified'), 'auth_session_unverified')
        self.assertEqual(classify_x_account_failure(text='session_unverified'), 'auth_session_unverified')

    def test_explicit_captcha_codes_return_captcha(self):
        # 326, 353, 399, 241 and explicit challenge/bounce keywords
        self.assertEqual(classify_x_account_failure(errors=[{'code': 326}]), 'captcha')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 353}]), 'captcha')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 399}]), 'captcha')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 241}]), 'captcha')
        self.assertEqual(classify_x_account_failure(text='Arkose challenge required'), 'captcha')
        self.assertEqual(classify_x_account_failure(text='login_verification required'), 'captcha')
        self.assertEqual(classify_x_account_failure(raw_json={'bounce_location': 'https://x.com/account/access'}), 'captcha')

    def test_explicit_suspension_returns_banned(self):
        self.assertEqual(classify_x_account_failure(errors=[{'code': 64}]), 'banned')
        self.assertEqual(classify_x_account_failure(text='account suspended'), 'banned')

    def test_explicit_cookie_expired_returns_cookie_expired(self):
        self.assertEqual(classify_x_account_failure(errors=[{'code': 89}]), 'cookie_expired')
        self.assertEqual(classify_x_account_failure(text='token is expired'), 'cookie_expired')

if __name__ == '__main__':
    unittest.main()
