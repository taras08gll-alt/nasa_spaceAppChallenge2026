# LUNA-DOC: One-dimensional transient heat conduction in regolith; depth z increases downward.
# LUNA-DOC: Heat capacity, density, and conductivity depend on model assumptions; values are not direct temperature measurements.
# LUNA-DOC: Keep units consistent (K, m, s, and W/m^2) and check numerical time-step stability.
"""One-dimensional lunar regolith heat equation, with depth increasing downward."""

import math

import numpy as np

from lunar_surface_pipeline import SIGMA

try:
    from scipy.linalg.lapack import dgtsv
except ImportError:
    dgtsv = None

# Hayne et al. (2017), Table A1, https://doi.org/10.1002/2017JE005387
SURFACE_DENSITY_KG_M3 = 1100.0
DEEP_DENSITY_KG_M3 = 1800.0
SCALE_HEIGHT_M = 0.06
SURFACE_CONTACT_W_M_K = 7.4e-4
DEEP_CONTACT_W_M_K = 3.4e-3
RADIATIVE_FACTOR = 2.7
RADIATIVE_REFERENCE_K = 350.0
HEAT_CAPACITY_COEFFICIENTS = (-3.6125, 2.7431, 2.3616e-3, -1.2340e-5, 8.9093e-9)
EMISSIVITY = 0.95
NORMAL_ALBEDO = 0.12
ALBEDO_CUBIC = 0.06
ALBEDO_EIGHTH = 0.25
GEOTHERMAL_FLUX_W_M2 = 0.018

EMISSION_COEFFICIENT = EMISSIVITY * SIGMA
RADIATIVE_COEFFICIENT = RADIATIVE_FACTOR / RADIATIVE_REFERENCE_K**3
ENTHALPY_COEFFICIENTS = (0.0, *(c / i for i, c in enumerate(HEAT_CAPACITY_COEFFICIENTS, 1)))


# LUNA-DOC: Calculate energy flux absorbed by the surface using albedo and geometry.
def absorbed_solar_flux(incident, cos_incidence):
    if incident <= 0:
        return 0.0
    angle = math.acos(min(1.0, cos_incidence))
    return incident * (1 - solar_albedo(angle))


# LUNA-DOC: Calculate albedo with the selected surface parameterization.
def solar_albedo(angle):
    return (
        NORMAL_ALBEDO + ALBEDO_CUBIC * (angle / (math.pi / 4))**3
        + ALBEDO_EIGHTH * (angle / (math.pi / 2))**8
    )


# LUNA-DOC: Calculate conductive heat flux between adjacent regolith layers.
def conduction_potential(temperature):
    # Its derivative is 1 + chi * (T / 350 K)^3.
    return temperature + (RADIATIVE_COEFFICIENT / 4) * temperature**4


# LUNA-DOC: Helper for solving the fourth-order radiative balance equation.
def _quartic_temperature(linear, quartic, rhs):
    """Positive root of linear * T + quartic * T**4 = rhs."""
    temperature = np.minimum(rhs / linear, np.sqrt(np.sqrt(rhs / quartic)))
    for _ in range(12):
        change = (linear * temperature + quartic * temperature**4 - rhs) / (
            linear + 4 * quartic * temperature**3
        )
        temperature -= change
        if np.max(np.abs(change)) <= 1e-8:
            return temperature
    raise ArithmeticError("Regolith boundary temperature did not converge")


# LUNA-DOC: Solve a tridiagonal system, using LAPACK when available.
def _solve_tridiagonal(lower, diagonal, upper, rhs):
    """Solve the tridiagonal Newton step in place when possible."""
    if dgtsv is not None:
        shape = rhs.shape
        layers = len(diagonal)
        if rhs.ndim > 1:
            # Pack independent terrain columns into one banded system with zero coupling.
            columns = rhs.size // layers
            bands = np.zeros((2, columns, layers))
            bands[0, :, :-1] = lower.reshape(layers - 1, columns).T
            bands[1, :, :-1] = upper.reshape(layers - 1, columns).T
            lower, upper = (band.ravel()[:-1] for band in bands)
            diagonal = diagonal.T.ravel()
            rhs = rhs.T.ravel()

        _, _, _, solution, info = dgtsv(lower, diagonal, upper, rhs,
                                        overwrite_dl=1, overwrite_d=1, overwrite_du=1, overwrite_b=1)
        if info != 0:
            raise ArithmeticError("Regolith heat balance could not be solved")
        return solution.reshape(shape[::-1]).T

    return _solve_tridiagonal_numpy(lower, diagonal, upper, rhs)


# LUNA-DOC: Fallback solver that does not require SciPy.
def _solve_tridiagonal_numpy(lower, diagonal, upper, rhs):
    """Eliminate the lower diagonal and back-substitute."""
    for i in range(1, len(diagonal)):
        factor = lower[i - 1] / diagonal[i - 1]
        diagonal[i] -= factor * upper[i - 1]
        rhs[i] -= factor * rhs[i - 1]
    rhs[-1] /= diagonal[-1]
    for i in range(len(diagonal) - 2, -1, -1):
        rhs[i] = (rhs[i] - upper[i] * rhs[i + 1]) / diagonal[i]
    return rhs


# LUNA-DOC: Discretized vertical soil column with temperature layers.
class RegolithColumn:
    # LUNA-DOC: The __init__ method initializes this class; refer to the implementation for its arguments and behavior.
    def __init__(self, *, depth_m=1.0, layers=32, spacing_ratio=1.13):
        # Resolve the thin surface layer with small cells and expand toward the base.
        widths = spacing_ratio**np.arange(layers)
        widths *= depth_m / widths.sum()
        edges = np.r_[0.0, widths.cumsum()]
        centres = edges[:-1] + widths / 2
        self.depths_m = np.r_[0.0, centres]

        density = DEEP_DENSITY_KG_M3 - (DEEP_DENSITY_KG_M3 - SURFACE_DENSITY_KG_M3) * np.exp(
            -centres / SCALE_HEIGHT_M
        )
        self._mass = np.r_[0.0, density * widths]
        interface_depths = np.r_[centres[0] / 2, edges[1:-1]]
        contact = DEEP_CONTACT_W_M_K - (DEEP_CONTACT_W_M_K - SURFACE_CONTACT_W_M_K) * np.exp(
            -interface_depths / SCALE_HEIGHT_M
        )
        self._conductance = contact / np.diff(self.depths_m)
        self._conductance_sum = np.r_[self._conductance, 0.0] + np.r_[0.0, self._conductance]

    # LUNA-DOC: Calculate the top boundary temperature from the radiative balance.
    def _surface_temperature(self, first_layer_k, absorbed):
        conductance = self._conductance[0]
        return _quartic_temperature(
            conductance,
            EMISSION_COEFFICIENT + conductance * RADIATIVE_COEFFICIENT / 4,
            absorbed + conductance * conduction_potential(first_layer_k),
        )

    # LUNA-DOC: Create an initial temperature-versus-depth profile.
    def initial_profile(self, absorbed, history):
        # Estimate a deep starting profile from the first lunar day of heating history.
        equilibrium = ((np.asarray(history) + GEOTHERMAL_FLUX_W_M2) / EMISSION_COEFFICIENT)**0.25
        geothermal = GEOTHERMAL_FLUX_W_M2 * np.r_[0.0, np.cumsum(1 / self._conductance)]
        potential = geothermal + np.mean(conduction_potential(equilibrium), axis=-1, keepdims=True)
        temperature = _quartic_temperature(1.0, RADIATIVE_COEFFICIENT / 4, potential)
        temperature[..., 0] = self._surface_temperature(temperature[..., 1], absorbed)
        return temperature

    # LUNA-DOC: Advance the heat conduction solution by one time step.
    # LUNA-DOC: Preserve the existing function contract; changing arguments can break frontend/backend compatibility.
    def advance(self, previous, absorbed, seconds):
        """Backward Euler applied to the enthalpy balance in each finite volume."""
        mass_per_second = self._mass / seconds
        temperature = previous.copy()
        temperature[..., 0] = self._surface_temperature(temperature[..., 1], absorbed)
        previous_enthalpy = np.polynomial.polynomial.polyval(previous, ENTHALPY_COEFFICIENTS)

        for _ in range(24):
            enthalpy = np.polynomial.polynomial.polyval(temperature, ENTHALPY_COEFFICIENTS)
            capacity = np.polynomial.polynomial.polyval(temperature, HEAT_CAPACITY_COEFFICIENTS)
            potential_gradient = self._conductance * np.diff(conduction_potential(temperature))

            # Sum the fluxes into each cell. The surface has zero storage.
            residual = mass_per_second * (enthalpy - previous_enthalpy)
            residual[..., :-1] -= potential_gradient
            residual[..., 1:] += potential_gradient
            residual[..., 0] += EMISSION_COEFFICIENT * temperature[..., 0]**4 - absorbed
            residual[..., -1] -= GEOTHERMAL_FLUX_W_M2

            gradient_derivative = 1 + RADIATIVE_COEFFICIENT * temperature**3
            diagonal = mass_per_second * capacity + self._conductance_sum * gradient_derivative
            diagonal[..., 0] += 4 * EMISSION_COEFFICIENT * temperature[..., 0]**3
            change = _solve_tridiagonal(
                (-self._conductance * gradient_derivative[..., :-1]).T, diagonal.T,
                (-self._conductance * gradient_derivative[..., 1:]).T, (-residual).T,
            ).T
            if np.max(np.abs(change)) <= 1e-6:
                return temperature + change

            cooling = change < 0
            ratios = np.ones_like(change)
            np.divide(-temperature, 2 * change, out=ratios, where=cooling)
            temperature += np.minimum(1, ratios.min(axis=-1, keepdims=True)) * change

        raise ArithmeticError("Regolith heat equation did not converge")
